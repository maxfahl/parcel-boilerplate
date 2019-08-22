/*
 * Copyright (c) PIXILAB Technologies AB, Sweden (http://pixilab.se). All Rights Reserved.
 * Created 2017 by Mike Fahl.
 */

/// <reference path = '../../../typings/globals/es6-collections/index.d.ts' />
/// <reference path = '../../../typings/globals/core-js/index.d.ts' />

export interface IMsgHandler {

	/**
	 * Handle message. If message is a query, then return result if available immediately,
	 * or a promise resolved when the answer becomes available, else return undefined.
	 * Throws if error occurs during processing.
	 */
	handle(msg: WSMsg): any;
}

/**
 * Interface to be implemented by receivers of property/stream data obtained through
 * a PubSubPeer subscription.
 */
export interface DataHandler<T> {
	dataReceived(newvalue: T, path: string): void;
}

/**
 * What I track for each subscription
 */
class Subscription<T> {
	handlers: Set< DataHandler<T>>;	// Handlers to call with data
	lastValue?: T;	// Last received value, if any (not used for stream)

	constructor() {
		this.handlers = new Set< DataHandler<T>>();
	}
}

/**
 * Track pending queries. Stored in PubSubPeer pendingQueries, keyed by query ID.
 */
interface PendingQuery<ResponseT> {
	resolver: (value: ResponseT) => void;	// Call when reply arrives
	rejector: (reason?: string) => void;	// Call on failure
}

interface Dictionary<TElem> {
	[id: string]: TElem;
}

/**
 * Manage the client side of web socket property pub-sub communications.
 */
export class PubSubPeer {
	private static kStreamPrefix = "$Stream.";	// Indicates stream subscription (vs property)
	public static kChannelStreamInfix = "$Channel.";

	private wsUrl: string;	// Full URl to connect websocket
	private readonly msgHandler: IMsgHandler;	// Handles non-pub/sub messages
	private readonly autoConnect: boolean;	// Attempt to reconnect automatically

	// Currently subscribed properties, keyed by path
	private subscribers: Dictionary<Subscription<any>> = {};

	// Accumulators to consolidate multiple calls to one server request
	private toSubscribe: Dictionary<boolean> = {} // Value is not used
	private toUnsubscribe: Dictionary<boolean> = {}// Value is not used
	private toSet: Dictionary<any>= {}	// Value is what to set
	private toAdd: Dictionary<any> = {}	// Value is what to add

	private toTell: WSMsg[];	// Waiting to be sent to server side

	private lastQueryId: number;	// ID of most recently sent query (0 if none)
	private pendingQueries: Dictionary<PendingQuery<any>>;	// Pending queries, or undefined

	private socket: WebSocket;		// Set once connection attempt started
	private online: boolean;		// Websock connection status
	private pendingServerCall: number;	// Timeout for server call
	private pendingConnect: number;	// Timeout for server (re-)connect

	private readonly stateChangeNotifier: (online: boolean)=>void;

	/**
	 * Get me going, setting an optional function to be called when my
	 * connection state changes. If you specify serverPath, this should
	 * NOT include protocol and location.host. If you care
	 * about other messages than pub-sub ones, pass in your msgHandler.
	 * By default, I will attempt to connect and re-connect automatically.
	 * If you don't like this, pass false to autConnect, and call
	 * connect from outside (then you must also handle re-connection).
	 */
	public constructor(
		stateChangeNotifier?: (online: boolean)=>void,
		serverPath?: string,		// Default provided below
		msgHandler?: IMsgHandler,	// Handles non-subscription related messages
		autoConnect = true			// Re-connect socket auto if fails
	) {
		this.stateChangeNotifier = stateChangeNotifier;
		this.msgHandler = msgHandler;
		this.lastQueryId = 0;
		if (autoConnect)
			this.connect(serverPath);
		// Must set autoConnect AFTER calling connect above
		this.autoConnect = autoConnect;
	}

	/**
	 * Alternative way of connecting for use if you passed autoConnect false
	 * to the ctor
	 */
	connect(serverPath?: string) {
		if (this.autoConnect) {
			log.error("Don't call connect if set to auto-connect")
			return;	// Ignore this call if I handle myself
		}

		if (serverPath || !this.wsUrl) { // Inital setup or update wsUrl
			const protoHostRegex = /^(http|https):\/\/(.+?)(\/.*)/;
			var protocol: string;
			var host: string;
			var pieces: RegExpExecArray;
			if (serverPath && (pieces = protoHostRegex.exec(serverPath))) {
				// Was full path, including origin protocol and host
				protocol = pieces[1];
				host = pieces[2];
				serverPath =  pieces[3];
			} else {
				// Infer protocol and host (serverPath presumably  begins with '/')
				protocol = location.protocol;
				host = location.host;
			}
			var urlPrefix = protocol == 'https:' ? 'wss://' : 'ws://';
			urlPrefix += host;

			if (!serverPath)	// Use default path to be backwards compatible
				serverPath = "/rpc/pub-sub";
			this.wsUrl = urlPrefix + serverPath;
		}
		this.attemptToConnectSoon(5);
	}


	/**
	 * Subscribe to specfied path, calling dataCallback when server reports
	 * a change. I return any existing value already obtained from this property,
	 * if any, which caller may use. I decided to return this instead of
	 * iummediately turning around and dataCallback with any preexisting data
	 * as doing so reduced the chance of unexpected behavior in the callback;
	 * e.g. if subscribe is called as a result of an Ancular watch firing,
	 * and the callback then performing $apply, which may result in digest
	 * errors, etc. This design is debatable, but was considered "safer" for
	 * now since I initially wanted this preexisting data mainly for buttons
	 * when a panel reconnects.
	 */
	public subscribe<T>(path: string, dataCallback: DataHandler<T>): T|undefined {
		var subs = this.subscribers[path];
		if (!subs) {	// Not already subscribed
			this.subscribers[path] = subs = new Subscription<any>();
			this.toSubscribe[path] = true;
			delete this.toUnsubscribe[path];
			this.requestServerCall();
		} // else if (subs.lastValue !== undefined) // SEE BLOCK COMMENT ABOVE
			// dataCallback.dataReceived(subs.lastValue, path);
		subs.handlers.add(dataCallback);
		return subs.lastValue;
	}

	/**
	 * Detach dataCallback from path so it will no longer be called on changes.
	 */
	public unsubscribe(path: string, dataCallback:DataHandler<any>): void {
		var subs = this.subscribers[path];
		if (subs) {
			if (!subs.handlers.delete(dataCallback)) // Should not fail, really
				console.warn("PubSubPeer no callback for", path)
			if (subs.handlers.size === 0) {
				delete this.subscribers[path];
				this.toUnsubscribe[path] = true;
				delete this.toSubscribe[path];
				this.requestServerCall();
			}
		}
	}

	/**
	 * Convenience combination of the two above, when subscribe/unsubscribe is determined
	 * by a boolean.
	 */
	public subUnsub<T>(subscribe: boolean, path: string, changeCallback:DataHandler<T>) {
		if (subscribe)
			this.subscribe(path, changeCallback);
		else
			this.unsubscribe(path, changeCallback);
	}

	/**
	 * Set path to value.
	 */
	public set(path: string, value: any) : void {
		this.toSet[path] = value;
		delete this.toAdd[path];

		// Setting also implies subscribing
		if (!this.subscribers[path])
			this.subscribers[path] = new Subscription<any>();
		delete this.toUnsubscribe[path];

		this.requestServerCall();
	}

	/**
	 * Add/append value to what's already at path.
	 */
	public add(path: string, value: any) : void {
		this.toAdd[path] = value;
		this.requestServerCall();
	}

	/**
	 * General "send message to endpoint". ToDo: Replace this with
	 * function-mapped RPC to neuron instead of mapping this
	 * through a "property", which it really isn't.
	 */
	public tell(path: string, value: any) : void {
		this.sendMsg(newPubSubCmd("tell", path, value));
	}

	/**
	 * Send toSend to stream/channel with name compName, which must start with "$Stream."
	 * followed by the script context (e.g., "Script.user.MyTest"), possibly followed
	 * by ".$Channel." and finally the local channel name, as produced by
	 * PubSubPeer.channelName()
	 */
	public send(compName: string, toSend: string): void {
		this.sendMsg(newPubSubCmd("send", compName, toSend));
	}

	/**
	 * Given a scriptContext (e.g. "Script.user.MyTest") and leaf channelName,
	 * returns the full composite channel name, that can subsequently
	 * be passed to subscribe, unsubscribe and sendStream.
	 */
	public static channelName(scriptContext: string, channelName: string): string {
		return	PubSubPeer.kStreamPrefix + scriptContext + '.' +
				PubSubPeer.kChannelStreamInfix + channelName;
	}

	/**
	 * Send reset command for stream at path. Initially devised to clear
	 * any backlog held in the stream.
	 */
	public resetStream(path: string) : void {
		this.sendMsg(newPubSubCmd("reset", path));
	}

	/**
	 * Send a "warning" message to the server from this spot. The server will log
	 * this along with param (which is typically a Str1Par or a Str2Par.
	 */
	logWarning(param: WSMsgPar) {
		this.sendMsg({name: "warning", param: param});
		console.warn(JSON.stringify(param));	// Also to console to aid in local debugging
	}

	/**
	 * Send an "error" message to the server from this spot. The server will log
	 * this along with param (which is typically a Str1Par or a Str2Par.
	 */
	logError(param: WSMsgPar) {
		this.sendMsg({name: "error", param: param});
		console.error(param);
	}

	/**
	 * Send msg to server ASAP.
	 */
	public sendMsg(msg: WSMsg) {
		if (!this.toTell)
			this.toTell = [];
		if (this.online || this.toTell.length < 30) {
			this.toTell.push(msg);
			this.requestServerCall();
		} else // Don't accumulate any more if socket closed
			console.error("Dropped WSMsg. No socket.")
	}

	/**
	 * Send msg as a question. Once the corresponding reply arrives,
	 * resolve the returned promise (or reject it if we fail). Will
	 * be rejected IMMEDIATELY if I'm currently offline, so you may
	 * want to pre-flight that.
	 *
	 * ToDo: Possibly add some mechanism to reject unanswered
	 * queries after some reasonably long time.
	 */
	public ask<ReplyT>(msg: WSMsg): Promise<ReplyT> {
		return new Promise<ReplyT>((resolve, reject) => {
			if (!this.online)
				reject("Offline");	// No can do - reject immediately
			else {
				msg.id = ++this.lastQueryId;
				var queries = this.pendingQueries;
				if (!queries)
					this.pendingQueries = queries = {};
				queries[msg.id] = {
					resolver: resolve,
					rejector: reject
				};
				this.sendMsg(msg);
			}
		});
	}

	/**
	 * Try to connect to web socket after delayMs.
	 */
	private attemptToConnectSoon(delayMs: number) {
		if (!this.pendingConnect) {
			this.pendingConnect = window.setTimeout(()=> {
				this.pendingConnect = undefined;
				this.attemptConnect();
			}, delayMs);
		}
	}

	/**
	 * Attempt a server connection. Called through attemptToConnectSoon.
	 * If fails, will request a new attempt through attemptToConnectSoon.
	 */
	private attemptConnect() {
		this.discardSocket();		// Get rid of any old instance
		const socket = new WebSocket(this.wsUrl);
		this.socket = socket;

		socket.onopen = () => {
			this.subscribeAll();	// Start existing subscriptions
			this.setOnline(true);
			this.tellServer();		// Send any accumulated inital data
		};

		socket.onmessage = msg => {
			this.treatIncomingData(JSON.parse(msg.data));
		};

		socket.onerror = socket.onclose = (event: Event) => {
			this.discardSocket();
			if (this.autoConnect)
				this.attemptToConnectSoon(2000);	// Re-try soon again
			this.setOnline(false);
		};
	}

	/**
	 Disconnect handlers from socket and discard it. Does nothing if got no
	 socket connected.
	 */
	private discardSocket() {
		const socket = this.socket;
		if (socket) {
			socket.onopen = undefined;
			socket.onmessage = undefined;
			socket.onerror = undefined;
			this.setOnline(false);
			socket.close();
			delete this.socket;
		}
	}

	/**
	 * Set my online state and notify any listener.
	 */
	private setOnline(online: boolean) {
		if (this.online !== online) {	// This is news
			this.online = online;
			const queries = this.pendingQueries;
			if (!online && queries) {
				// Reject all pending queries when goes offline
				for (const id in queries) {
					const query = queries[id];
					if (query.rejector)
						query.rejector("Offline");
				}
				this.pendingQueries = undefined; // All gone
			}
		}
		if (this.stateChangeNotifier) // Always notify - even if no change (e.g., connect failed)
			this.stateChangeNotifier(online);
	}

	/**
	 * Return my online status, which may initially be undefined.
	 */
	public isOnline() {
		return this.online;
	}

	/**
	 * Got what an array of messages from server. Handle protocol level commands,
	 * and pass on pub-sub and other "unknown" messages to handleMsg.
	 */
	private treatIncomingData(messages: WSMsg[]): void {
		// console.log("WS Incoming data");
		for (var msg of messages) {
			switch (msg.name) {
			case 'change':	// Property change subscription case
				this.handleNewData(<PubSubPar>msg.param, false);
				break;
			case 'stream':	// Stream subscription case
				this.handleNewData(<PubSubPar>msg.param, true);
				break;
			case 'ping':
				this.sendMsg({name: 'pong'});
				break;
			case 'reply':	// ACK reply to query sent by me
				if (msg.isResponse && msg.id && msg.param) {
					const data = (<ReplyPar<any>>(msg.param)).data;
					this.handleReply(msg.id, data);
					break;
				}
				console.error("Bad reply msg", msg);
				break;
			case 'queryError':	// NAK response to query, with single error string param
				if (msg.isResponse && msg.id && msg.param) {
					const data = (<ReplyPar<Str1Par>>(msg.param)).data;
					this.handleQueryError(msg.id, data);
					break;
				}
				console.error("Bad queryError msg", msg);
				break;
			default:
				this.handleMsg(msg);
				break;
			}
		}
	}

	/**
	 handle new data, of either property or stream type.
	 */
	private handleNewData(par: PubSubPar, isStream: boolean) {
		var callbacks = this.subscribers[par.path];	// Lookup on full path
		if (callbacks) {
			let path = par.path;
			if (isStream) {
				// Verify has expected on-the-wire stream prefix
				if (path.indexOf(PubSubPeer.kStreamPrefix) != 0) {
					console.error("Bad stream path", path);
					return;
				}
				// Terminate subscription if stream closed
				if (!par.data) { // Null data indicates CLOSE
					delete this.subscribers[par.path];
					// Fwd CLOSE null data to inform subscriber
				}
				// Trim off any kStreamPrefix before passing on
				path = path.substr(PubSubPeer.kStreamPrefix.length);
			} else	// Remember last received value
				callbacks.lastValue = par.data;
			// Send stream/value data update to all handlers
			callbacks.handlers.forEach(hdl =>
				hdl.dataReceived(par.data, path)
			);
		}
	}

	/**
	 * Got reply to a query with specified id. Resolve associated promise
	 * with provided data (which hopefully is of the expected type).
	 */
	private handleReply(id: number, reply: ReplyPar<any>) {
		const queries = this.pendingQueries;
		if (queries) {
			const query = queries[id];
			if (query) {
				delete queries[id];
				try {
					query.resolver(reply);
				} catch (error) {
					console.error("Resolving reply for", id, error);
				}
				return;
			}
		}
		console.error("No pending query", id);
	}

	/**
	 * Got an ERROR reply to a query with specified id. Reject associated promise.
	 */
	private handleQueryError(id: number, msg: Str1Par) {
		const queries = this.pendingQueries;
		if (queries) {
			const query = queries[id];
			if (query) {
				delete queries[id];
				try {
					query.rejector(msg.s1);
				} catch (error) {
					console.error("Rejecting reply for", id, error);
				}
				return;
			}
		}
		console.error("No pending query (error)", id);
	}


	/**
	 * Handle a message (except "protocol level" msgs handled above).
	 */
	private handleMsg(msg: WSMsg): void {
		// console.log("Socket data");
		var response: any;
		var reply:WSMsg = {		// Some useful default "OK" reply
			name: 'reply',		// May be revised below
			id: msg.id,
			isResponse: true,
			param: new Str1Par("OK")
		};
		try {
			if (this.msgHandler)
				response = this.msgHandler.handle(msg);
		} catch (error) {	// Command failed - respond with some error string
			if (msg.id) {		// Had msg id - some response expected
				if (typeof error !== "string")
					error = "Unspecific error";
				reply.name = 'error';
				reply.param = new Str1Par(error);
				this.sendMsg(reply);
			}
			return;
		}
		if (msg.id) {	// Had msg id - some response expected
			if (response !== undefined) {	// Command with reply
				if (response instanceof Promise) {	// Deal with promise in due course
					var promise:Promise<any> = response;
					promise.then(
						success => {
							var resType = typeof success;
							if (resType === "string")
								reply.param = new Str1Par(success);
							else if (resType === 'object')
								reply.param = success;
							this.sendMsg(reply);
						}, error => {
							reply.name = 'error';
							reply.param = new Str1Par(error);
							this.sendMsg(reply);
						}
					);
				} else {	// Handle direct response
					var respType = typeof response;
					if (respType === "string")
						reply.param = new Str1Par(<string>response);
					else if (respType === "boolean")
						reply.param = new BoolPar(<boolean>response);
					// Add more response types here later
					this.sendMsg(reply);
				}
			} else	// Had message ID - always give some response
				this.sendMsg(reply);
		}
	}

	/**
	 * Copy all from subscribed to toSubscribe to make sure server knows
	 * about this. This is done once after successfully connected, to
	 * reconnect all existing subscriptions, which then likely have been
	 * dropped by the server.
	 */
	private subscribeAll(): void {
		for (var path in this.subscribers)
			this.toSubscribe[path] = true;
	}

	/**
	 * Make sure accumulated data is sent to server ASAP. I'll schedule a call soon
	 * if one isn't already scheduled. I will NOT do anything if socket not connected,
	 * as the initial connection will send accumulated data.
	 */
	private requestServerCall(): void {
		if (!this.pendingServerCall && this.online) {
			this.pendingServerCall = window.setTimeout(()=> {
				this.pendingServerCall = undefined;
				this.tellServer();
			}, 10);
		}
	}

	/**
	 * Send accumulated, if any, to server over websocket.
	 */
	private tellServer(): void {
		if (this.online) {
			var commands: WSMsg[] = this.toTell || [];
			this.toTell = [];	// Now consider taken

			addCommandsFor(commands, 'subscribe', this.toSubscribe);
			this.toSubscribe = {};

			addCommandsFor(commands, 'unsubscribe', this.toUnsubscribe);
			this.toUnsubscribe = {};

			addCommandsFor(commands, 'set', this.toSet, true);
			this.toSet = {};

			addCommandsFor(commands, 'add', this.toAdd, true);
			this.toAdd = {};

			if (commands.length)
				this.socket.send(JSON.stringify(commands));
		}
	}
}

/**
 * Add cmdName to commands for all paths in dict, including its data if inclData.
 */
function addCommandsFor(commands: WSMsg[], cmdName: string, dict: { [path: string]: any }, inclData?: boolean) {
	for (var path in dict)
		commands.push(newPubSubCmd(cmdName, path, inclData ? dict[path] : undefined));
}

/**
 * Build a command to send to the pub-sub endpoint on the server.
 */
function newPubSubCmd(command: string, path: string, data?: any): WSMsg {
	return {
		name: command,
		param: new PubSubPar(path, data)
	}
}

/*	Following types WSMsg, WSMsgPar, PubSubPar COPIED from corresponding in display.
 	Need to arrange this in some smarter way once pub/sub is moved into the Spot
 	codebase, and possibly provide as a library to include separately from other
 	JS apps that may want to use it.
*/


/**
 * A message sent over websock connection. Also exists server side with same name.
 */
export interface WSMsg {
	name: string;			// Command/response name
	id?: number;			// ID of query/reply, or 0 if not a query
	isResponse?: boolean;	// Set if this is reply to a query
	param?: WSMsgPar;		// Command parameter(s), if any
}

/**
 * Data sent with the message.
 */
export interface WSMsgPar {
	type: string;	// Relative server side class name, starting with '.'
	// Other data depending on type
}


/**	Websocket command param used for setting and subscribing/publishing property
 * data and changes.
 */
class PubSubPar implements WSMsgPar {
	type: string;

	constructor(
		public path: string,
		public data: any
	) {
		this.type = '.PubSubPar';	// Must match server side class name
	}
}


/**
 * A boolean command parameter.
 */
export class BoolPar implements WSMsgPar {
	type: string;

	constructor(public bool:boolean) {
		this.type = '.BoolPar';	// Must match server side class name
	}
}

/**
 * A numeric command parameter.
 */
export class NumPar implements WSMsgPar {
	type: string;

	constructor(public value:number) {
		this.type = '.NumPar';	// Must match server side class name
	}
}

/**
 * A single string command parameter.
 */
export class Str1Par implements WSMsgPar {
	type: string;

	constructor(public s1:string) {
		this.type = '.Str1Par';	// Must match server side class name
	}
}

/**
 * A two string command parameter.
 */
export class Str2Par implements WSMsgPar {
	type: string;

	constructor(public s1:string, public s2:string) {
		this.type = '.Str2Par';	// Must match server side class name
	}
}

/**
 * The "tick" message parameter, telling me about the server time, which
 * can subsequently be used to time other events with reasonable
 * accuracy.
 */
export class TickPar implements WSMsgPar {
	type: string;

	constructor(public sessionId:number, public serverTime:number) {
		this.type = '.TickPar';	// Must match server side class name
	}
}

/**
 * Synchronization message, sent to server to inform him about time position
 * of a synchronizer master. Also exists on server side under same name.
 */
export class SyncPar implements WSMsgPar {
	type: string;

	constructor(
		private path:string,	// Sub-path to property under neuron holding sync data
		private time: number,	// Current time position
		private rate: number,	// Current rate (0 is pause, 1 is nominal)
		private serverTime: number, // Corresponding server time (0 if unknown)
		private optBlock?: string	// Block playing (optional)
	) {
		this.type = '.SyncPar';	// Must match server side class name
	}
}

/**
 * A general purpose "object array" parameter type. Mainly for primitive
 * types, such as string, number, boolean, which works well on both sides
 * of the fence.
 */
export class ArrayPar implements WSMsgPar {
	type: string;

	constructor(public elems: any[]) {
		this.type = '.ArrayPar';	// Must match server side class name
	}
}

/**
 * A somewhat degenerate "reply" parameter, used with my incoming "reply"
 * message only (which is never sent to server).
 */
export class ReplyPar<ReplyType> implements WSMsgPar {
	type: string;		// Just to keep TypeScript happy - not actually used
	data: ReplyType;	// Reply data payload
}

/**
 * Data indicating a time position and rate. Used for playback and sync purposes.
 * Same exists server side with same name.
 */
export interface TimeFlow {
	position: number;		// Current time position, in mS
	rate: number;			// Time flow rate, in seconds per second (0 is stopped)
	serverTime?: number;	// Corresponding server time, in mS, if applicable
	dead?: boolean;			// Timeline is dead (position and rate irrelevant)
	optBlock?: string;		// Associated root level block, if known
}
