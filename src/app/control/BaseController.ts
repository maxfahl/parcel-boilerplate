/*
 * Copyright (c) PIXILAB Technologies AB, Sweden (http://pixilab.se). All Rights Reserved.
 * Created 2017 by Mike Fahl.
 */
import {PubSubPeer} from "./PubSubPeer";

/**
 * An "angular controller" base class that helps with subscribing to properties
 * using the PubSubPeer and publishing the resulting data on the scope.
 */
export class BaseController {
	private pubSub: PubSubPeer;

	constructor(protected $scope:angular.IScope, protected propPathPrefix: string) {
		this.pubSub = new PubSubPeer(function() {
			$scope.$apply();	// UI may want to reflect online state
		});
	}

	private augmentName(name: string): string {
		if (name.indexOf('.') == -1) // Prepend prefix only if looks like leaf name
			name = this.propPathPrefix + name;
		return name;
	}

	/**
	 * Subscribe to name so that the property on me with that name will
	 * be updated to reflect changes from server through pub-sub.
	 */
	public subscribe<T>(name: string, optIndex?:number, changeNotification?:(newValue:T)=>void): void {
		if (optIndex != undefined) {
			this.pubSub.subscribe<T>(
				this.augmentName(name) + optIndex, {
					dataReceived: (newValue: T) => {
						(<any>this)[name][optIndex] = newValue;
						if (changeNotification)
							changeNotification(newValue);
						this.$scope.$apply();
					}
				}
			);
		} else {
			this.pubSub.subscribe<T>(
				this.augmentName(name), {
					dataReceived: (newValue: T) => {
						(<any>this)[name] = newValue;
						if (changeNotification)
							changeNotification(newValue);
						this.$scope.$apply();
					}
				}
			);
		}
	}

	/**
	 * Add amount to property with specified name, through pub-sub.
	 * Either specify index and amount (for indexed property) else
	 * just amount.
	 */
	public addTo(name: string, amountOrIndex: number, amount?:number) {
		if (amount !== undefined)
			this.pubSub.add(this.augmentName(name) + amountOrIndex, amount);
		else
			this.pubSub.add(this.augmentName(name), amountOrIndex);
	}

	public set(name: string, valueOrIndex: any, value?:any) {
		if (value !== undefined)
			this.pubSub.set(this.augmentName(name) + valueOrIndex, value);
		else
			this.pubSub.set(this.augmentName(name), valueOrIndex);
	}

	/**
	 * Tell registered listener something.
	 */
	public tell(listener: string, what: any) {
		this.pubSub.tell(this.augmentName(listener), what);
	}
}
