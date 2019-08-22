/*
 * Copyright (c) PIXILAB Technologies AB, Sweden (http://pixilab.se). All Rights Reserved.
 * Created 2017 by Mike Fahl.
 */
define(["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    /// <reference path = '../../../typings/globals/es6-collections/index.d.ts' />
    /// <reference path = '../../../typings/globals/core-js/index.d.ts' />
    /**
     * What I track for each subscription
     */
    var Subscription = /** @class */ (function () {
        function Subscription() {
            this.handlers = new Set();
        }
        return Subscription;
    }());
    /**
     * Manage the client side of web socket property pub-sub communications.
     */
    var PubSubPeer = /** @class */ (function () {
        /**
         * Get me going, setting an optional function to be called when my
         * connection state changes. If you specify serverPath, this should
         * NOT include protocol and location.host. If you care
         * about other messages than pub-sub ones, pass in your msgHandler.
         * By default, I will attempt to connect and re-connect automatically.
         * If you don't like this, pass false to autConnect, and call
         * connect from outside (then you must also handle re-connection).
         */
        function PubSubPeer(stateChangeNotifier, serverPath, // Default provided below
        msgHandler, // Handles non-subscription related messages
        autoConnect // Re-connect socket auto if fails
        ) {
            if (autoConnect === void 0) { autoConnect = true; }
            // Currently subscribed properties, keyed by path
            this.subscribers = {};
            // Accumulators to consolidate multiple calls to one server request
            this.toSubscribe = {}; // Value is not used
            this.toUnsubscribe = {}; // Value is not used
            this.toSet = {}; // Value is what to set
            this.toAdd = {}; // Value is what to add
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
        PubSubPeer.prototype.connect = function (serverPath) {
            if (this.autoConnect) {
                log.error("Don't call connect if set to auto-connect");
                return; // Ignore this call if I handle myself
            }
            if (serverPath || !this.wsUrl) { // Inital setup or update wsUrl
                var protoHostRegex = /^(http|https):\/\/(.+?)(\/.*)/;
                var protocol;
                var host;
                var pieces;
                if (serverPath && (pieces = protoHostRegex.exec(serverPath))) {
                    // Was full path, including origin protocol and host
                    protocol = pieces[1];
                    host = pieces[2];
                    serverPath = pieces[3];
                }
                else {
                    // Infer protocol and host (serverPath presumably  begins with '/')
                    protocol = location.protocol;
                    host = location.host;
                }
                var urlPrefix = protocol == 'https:' ? 'wss://' : 'ws://';
                urlPrefix += host;
                if (!serverPath) // Use default path to be backwards compatible
                    serverPath = "/rpc/pub-sub";
                this.wsUrl = urlPrefix + serverPath;
            }
            this.attemptToConnectSoon(5);
        };
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
        PubSubPeer.prototype.subscribe = function (path, dataCallback) {
            var subs = this.subscribers[path];
            if (!subs) { // Not already subscribed
                this.subscribers[path] = subs = new Subscription();
                this.toSubscribe[path] = true;
                delete this.toUnsubscribe[path];
                this.requestServerCall();
            } // else if (subs.lastValue !== undefined) // SEE BLOCK COMMENT ABOVE
            // dataCallback.dataReceived(subs.lastValue, path);
            subs.handlers.add(dataCallback);
            return subs.lastValue;
        };
        /**
         * Detach dataCallback from path so it will no longer be called on changes.
         */
        PubSubPeer.prototype.unsubscribe = function (path, dataCallback) {
            var subs = this.subscribers[path];
            if (subs) {
                if (!subs.handlers.delete(dataCallback)) // Should not fail, really
                    console.warn("PubSubPeer no callback for", path);
                if (subs.handlers.size === 0) {
                    delete this.subscribers[path];
                    this.toUnsubscribe[path] = true;
                    delete this.toSubscribe[path];
                    this.requestServerCall();
                }
            }
        };
        /**
         * Convenience combination of the two above, when subscribe/unsubscribe is determined
         * by a boolean.
         */
        PubSubPeer.prototype.subUnsub = function (subscribe, path, changeCallback) {
            if (subscribe)
                this.subscribe(path, changeCallback);
            else
                this.unsubscribe(path, changeCallback);
        };
        /**
         * Set path to value.
         */
        PubSubPeer.prototype.set = function (path, value) {
            this.toSet[path] = value;
            delete this.toAdd[path];
            // Setting also implies subscribing
            if (!this.subscribers[path])
                this.subscribers[path] = new Subscription();
            delete this.toUnsubscribe[path];
            this.requestServerCall();
        };
        /**
         * Add/append value to what's already at path.
         */
        PubSubPeer.prototype.add = function (path, value) {
            this.toAdd[path] = value;
            this.requestServerCall();
        };
        /**
         * General "send message to endpoint". ToDo: Replace this with
         * function-mapped RPC to neuron instead of mapping this
         * through a "property", which it really isn't.
         */
        PubSubPeer.prototype.tell = function (path, value) {
            this.sendMsg(newPubSubCmd("tell", path, value));
        };
        /**
         * Send toSend to stream/channel with name compName, which must start with "$Stream."
         * followed by the script context (e.g., "Script.user.MyTest"), possibly followed
         * by ".$Channel." and finally the local channel name, as produced by
         * PubSubPeer.channelName()
         */
        PubSubPeer.prototype.send = function (compName, toSend) {
            this.sendMsg(newPubSubCmd("send", compName, toSend));
        };
        /**
         * Given a scriptContext (e.g. "Script.user.MyTest") and leaf channelName,
         * returns the full composite channel name, that can subsequently
         * be passed to subscribe, unsubscribe and sendStream.
         */
        PubSubPeer.channelName = function (scriptContext, channelName) {
            return PubSubPeer.kStreamPrefix + scriptContext + '.' +
                PubSubPeer.kChannelStreamInfix + channelName;
        };
        /**
         * Send reset command for stream at path. Initially devised to clear
         * any backlog held in the stream.
         */
        PubSubPeer.prototype.resetStream = function (path) {
            this.sendMsg(newPubSubCmd("reset", path));
        };
        /**
         * Send a "warning" message to the server from this spot. The server will log
         * this along with param (which is typically a Str1Par or a Str2Par.
         */
        PubSubPeer.prototype.logWarning = function (param) {
            this.sendMsg({ name: "warning", param: param });
            console.warn(JSON.stringify(param)); // Also to console to aid in local debugging
        };
        /**
         * Send an "error" message to the server from this spot. The server will log
         * this along with param (which is typically a Str1Par or a Str2Par.
         */
        PubSubPeer.prototype.logError = function (param) {
            this.sendMsg({ name: "error", param: param });
            console.error(param);
        };
        /**
         * Send msg to server ASAP.
         */
        PubSubPeer.prototype.sendMsg = function (msg) {
            if (!this.toTell)
                this.toTell = [];
            if (this.online || this.toTell.length < 30) {
                this.toTell.push(msg);
                this.requestServerCall();
            }
            else // Don't accumulate any more if socket closed
                console.error("Dropped WSMsg. No socket.");
        };
        /**
         * Send msg as a question. Once the corresponding reply arrives,
         * resolve the returned promise (or reject it if we fail). Will
         * be rejected IMMEDIATELY if I'm currently offline, so you may
         * want to pre-flight that.
         *
         * ToDo: Possibly add some mechanism to reject unanswered
         * queries after some reasonably long time.
         */
        PubSubPeer.prototype.ask = function (msg) {
            var _this = this;
            return new Promise(function (resolve, reject) {
                if (!_this.online)
                    reject("Offline"); // No can do - reject immediately
                else {
                    msg.id = ++_this.lastQueryId;
                    var queries = _this.pendingQueries;
                    if (!queries)
                        _this.pendingQueries = queries = {};
                    queries[msg.id] = {
                        resolver: resolve,
                        rejector: reject
                    };
                    _this.sendMsg(msg);
                }
            });
        };
        /**
         * Try to connect to web socket after delayMs.
         */
        PubSubPeer.prototype.attemptToConnectSoon = function (delayMs) {
            var _this = this;
            if (!this.pendingConnect) {
                this.pendingConnect = window.setTimeout(function () {
                    _this.pendingConnect = undefined;
                    _this.attemptConnect();
                }, delayMs);
            }
        };
        /**
         * Attempt a server connection. Called through attemptToConnectSoon.
         * If fails, will request a new attempt through attemptToConnectSoon.
         */
        PubSubPeer.prototype.attemptConnect = function () {
            var _this = this;
            this.discardSocket(); // Get rid of any old instance
            var socket = new WebSocket(this.wsUrl);
            this.socket = socket;
            socket.onopen = function () {
                _this.subscribeAll(); // Start existing subscriptions
                _this.setOnline(true);
                _this.tellServer(); // Send any accumulated inital data
            };
            socket.onmessage = function (msg) {
                _this.treatIncomingData(JSON.parse(msg.data));
            };
            socket.onerror = socket.onclose = function (event) {
                _this.discardSocket();
                if (_this.autoConnect)
                    _this.attemptToConnectSoon(2000); // Re-try soon again
                _this.setOnline(false);
            };
        };
        /**
         Disconnect handlers from socket and discard it. Does nothing if got no
         socket connected.
         */
        PubSubPeer.prototype.discardSocket = function () {
            var socket = this.socket;
            if (socket) {
                socket.onopen = undefined;
                socket.onmessage = undefined;
                socket.onerror = undefined;
                this.setOnline(false);
                socket.close();
                delete this.socket;
            }
        };
        /**
         * Set my online state and notify any listener.
         */
        PubSubPeer.prototype.setOnline = function (online) {
            if (this.online !== online) { // This is news
                this.online = online;
                var queries = this.pendingQueries;
                if (!online && queries) {
                    // Reject all pending queries when goes offline
                    for (var id in queries) {
                        var query = queries[id];
                        if (query.rejector)
                            query.rejector("Offline");
                    }
                    this.pendingQueries = undefined; // All gone
                }
            }
            if (this.stateChangeNotifier) // Always notify - even if no change (e.g., connect failed)
                this.stateChangeNotifier(online);
        };
        /**
         * Return my online status, which may initially be undefined.
         */
        PubSubPeer.prototype.isOnline = function () {
            return this.online;
        };
        /**
         * Got what an array of messages from server. Handle protocol level commands,
         * and pass on pub-sub and other "unknown" messages to handleMsg.
         */
        PubSubPeer.prototype.treatIncomingData = function (messages) {
            // console.log("WS Incoming data");
            for (var _i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
                var msg = messages_1[_i];
                switch (msg.name) {
                    case 'change': // Property change subscription case
                        this.handleNewData(msg.param, false);
                        break;
                    case 'stream': // Stream subscription case
                        this.handleNewData(msg.param, true);
                        break;
                    case 'ping':
                        this.sendMsg({ name: 'pong' });
                        break;
                    case 'reply': // ACK reply to query sent by me
                        if (msg.isResponse && msg.id && msg.param) {
                            var data = (msg.param).data;
                            this.handleReply(msg.id, data);
                            break;
                        }
                        console.error("Bad reply msg", msg);
                        break;
                    case 'queryError': // NAK response to query, with single error string param
                        if (msg.isResponse && msg.id && msg.param) {
                            var data = (msg.param).data;
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
        };
        /**
         handle new data, of either property or stream type.
         */
        PubSubPeer.prototype.handleNewData = function (par, isStream) {
            var callbacks = this.subscribers[par.path]; // Lookup on full path
            if (callbacks) {
                var path_1 = par.path;
                if (isStream) {
                    // Verify has expected on-the-wire stream prefix
                    if (path_1.indexOf(PubSubPeer.kStreamPrefix) != 0) {
                        console.error("Bad stream path", path_1);
                        return;
                    }
                    // Terminate subscription if stream closed
                    if (!par.data) { // Null data indicates CLOSE
                        delete this.subscribers[par.path];
                        // Fwd CLOSE null data to inform subscriber
                    }
                    // Trim off any kStreamPrefix before passing on
                    path_1 = path_1.substr(PubSubPeer.kStreamPrefix.length);
                }
                else // Remember last received value
                    callbacks.lastValue = par.data;
                // Send stream/value data update to all handlers
                callbacks.handlers.forEach(function (hdl) {
                    return hdl.dataReceived(par.data, path_1);
                });
            }
        };
        /**
         * Got reply to a query with specified id. Resolve associated promise
         * with provided data (which hopefully is of the expected type).
         */
        PubSubPeer.prototype.handleReply = function (id, reply) {
            var queries = this.pendingQueries;
            if (queries) {
                var query = queries[id];
                if (query) {
                    delete queries[id];
                    try {
                        query.resolver(reply);
                    }
                    catch (error) {
                        console.error("Resolving reply for", id, error);
                    }
                    return;
                }
            }
            console.error("No pending query", id);
        };
        /**
         * Got an ERROR reply to a query with specified id. Reject associated promise.
         */
        PubSubPeer.prototype.handleQueryError = function (id, msg) {
            var queries = this.pendingQueries;
            if (queries) {
                var query = queries[id];
                if (query) {
                    delete queries[id];
                    try {
                        query.rejector(msg.s1);
                    }
                    catch (error) {
                        console.error("Rejecting reply for", id, error);
                    }
                    return;
                }
            }
            console.error("No pending query (error)", id);
        };
        /**
         * Handle a message (except "protocol level" msgs handled above).
         */
        PubSubPeer.prototype.handleMsg = function (msg) {
            var _this = this;
            // console.log("Socket data");
            var response;
            var reply = {
                name: 'reply',
                id: msg.id,
                isResponse: true,
                param: new Str1Par("OK")
            };
            try {
                if (this.msgHandler)
                    response = this.msgHandler.handle(msg);
            }
            catch (error) { // Command failed - respond with some error string
                if (msg.id) { // Had msg id - some response expected
                    if (typeof error !== "string")
                        error = "Unspecific error";
                    reply.name = 'error';
                    reply.param = new Str1Par(error);
                    this.sendMsg(reply);
                }
                return;
            }
            if (msg.id) { // Had msg id - some response expected
                if (response !== undefined) { // Command with reply
                    if (response instanceof Promise) { // Deal with promise in due course
                        var promise = response;
                        promise.then(function (success) {
                            var resType = typeof success;
                            if (resType === "string")
                                reply.param = new Str1Par(success);
                            else if (resType === 'object')
                                reply.param = success;
                            _this.sendMsg(reply);
                        }, function (error) {
                            reply.name = 'error';
                            reply.param = new Str1Par(error);
                            _this.sendMsg(reply);
                        });
                    }
                    else { // Handle direct response
                        var respType = typeof response;
                        if (respType === "string")
                            reply.param = new Str1Par(response);
                        else if (respType === "boolean")
                            reply.param = new BoolPar(response);
                        // Add more response types here later
                        this.sendMsg(reply);
                    }
                }
                else // Had message ID - always give some response
                    this.sendMsg(reply);
            }
        };
        /**
         * Copy all from subscribed to toSubscribe to make sure server knows
         * about this. This is done once after successfully connected, to
         * reconnect all existing subscriptions, which then likely have been
         * dropped by the server.
         */
        PubSubPeer.prototype.subscribeAll = function () {
            for (var path in this.subscribers)
                this.toSubscribe[path] = true;
        };
        /**
         * Make sure accumulated data is sent to server ASAP. I'll schedule a call soon
         * if one isn't already scheduled. I will NOT do anything if socket not connected,
         * as the initial connection will send accumulated data.
         */
        PubSubPeer.prototype.requestServerCall = function () {
            var _this = this;
            if (!this.pendingServerCall && this.online) {
                this.pendingServerCall = window.setTimeout(function () {
                    _this.pendingServerCall = undefined;
                    _this.tellServer();
                }, 10);
            }
        };
        /**
         * Send accumulated, if any, to server over websocket.
         */
        PubSubPeer.prototype.tellServer = function () {
            if (this.online) {
                var commands = this.toTell || [];
                this.toTell = []; // Now consider taken
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
        };
        PubSubPeer.kStreamPrefix = "$Stream."; // Indicates stream subscription (vs property)
        PubSubPeer.kChannelStreamInfix = "$Channel.";
        return PubSubPeer;
    }());
    exports.PubSubPeer = PubSubPeer;
    /**
     * Add cmdName to commands for all paths in dict, including its data if inclData.
     */
    function addCommandsFor(commands, cmdName, dict, inclData) {
        for (var path in dict)
            commands.push(newPubSubCmd(cmdName, path, inclData ? dict[path] : undefined));
    }
    /**
     * Build a command to send to the pub-sub endpoint on the server.
     */
    function newPubSubCmd(command, path, data) {
        return {
            name: command,
            param: new PubSubPar(path, data)
        };
    }
    /**	Websocket command param used for setting and subscribing/publishing property
     * data and changes.
     */
    var PubSubPar = /** @class */ (function () {
        function PubSubPar(path, data) {
            this.path = path;
            this.data = data;
            this.type = '.PubSubPar'; // Must match server side class name
        }
        return PubSubPar;
    }());
    /**
     * A boolean command parameter.
     */
    var BoolPar = /** @class */ (function () {
        function BoolPar(bool) {
            this.bool = bool;
            this.type = '.BoolPar'; // Must match server side class name
        }
        return BoolPar;
    }());
    exports.BoolPar = BoolPar;
    /**
     * A numeric command parameter.
     */
    var NumPar = /** @class */ (function () {
        function NumPar(value) {
            this.value = value;
            this.type = '.NumPar'; // Must match server side class name
        }
        return NumPar;
    }());
    exports.NumPar = NumPar;
    /**
     * A single string command parameter.
     */
    var Str1Par = /** @class */ (function () {
        function Str1Par(s1) {
            this.s1 = s1;
            this.type = '.Str1Par'; // Must match server side class name
        }
        return Str1Par;
    }());
    exports.Str1Par = Str1Par;
    /**
     * A two string command parameter.
     */
    var Str2Par = /** @class */ (function () {
        function Str2Par(s1, s2) {
            this.s1 = s1;
            this.s2 = s2;
            this.type = '.Str2Par'; // Must match server side class name
        }
        return Str2Par;
    }());
    exports.Str2Par = Str2Par;
    /**
     * The "tick" message parameter, telling me about the server time, which
     * can subsequently be used to time other events with reasonable
     * accuracy.
     */
    var TickPar = /** @class */ (function () {
        function TickPar(sessionId, serverTime) {
            this.sessionId = sessionId;
            this.serverTime = serverTime;
            this.type = '.TickPar'; // Must match server side class name
        }
        return TickPar;
    }());
    exports.TickPar = TickPar;
    /**
     * Synchronization message, sent to server to inform him about time position
     * of a synchronizer master. Also exists on server side under same name.
     */
    var SyncPar = /** @class */ (function () {
        function SyncPar(path, // Sub-path to property under neuron holding sync data
        time, // Current time position
        rate, // Current rate (0 is pause, 1 is nominal)
        serverTime, // Corresponding server time (0 if unknown)
        optBlock // Block playing (optional)
        ) {
            this.path = path;
            this.time = time;
            this.rate = rate;
            this.serverTime = serverTime;
            this.optBlock = optBlock;
            this.type = '.SyncPar'; // Must match server side class name
        }
        return SyncPar;
    }());
    exports.SyncPar = SyncPar;
    /**
     * A general purpose "object array" parameter type. Mainly for primitive
     * types, such as string, number, boolean, which works well on both sides
     * of the fence.
     */
    var ArrayPar = /** @class */ (function () {
        function ArrayPar(elems) {
            this.elems = elems;
            this.type = '.ArrayPar'; // Must match server side class name
        }
        return ArrayPar;
    }());
    exports.ArrayPar = ArrayPar;
    /**
     * A somewhat degenerate "reply" parameter, used with my incoming "reply"
     * message only (which is never sent to server).
     */
    var ReplyPar = /** @class */ (function () {
        function ReplyPar() {
        }
        return ReplyPar;
    }());
    exports.ReplyPar = ReplyPar;
});
//# sourceMappingURL=PubSubPeer.js.map