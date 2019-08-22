define(["require", "exports", "./PubSubPeer"], function (require, exports, PubSubPeer_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    /**
     * An "angular controller" base class that helps with subscribing to properties
     * using the PubSubPeer and publishing the resulting data on the scope.
     */
    var BaseController = /** @class */ (function () {
        function BaseController($scope, propPathPrefix) {
            this.$scope = $scope;
            this.propPathPrefix = propPathPrefix;
            this.pubSub = new PubSubPeer_1.PubSubPeer(function () {
                $scope.$apply(); // UI may want to reflect online state
            });
        }
        BaseController.prototype.augmentName = function (name) {
            if (name.indexOf('.') == -1) // Prepend prefix only if looks like leaf name
                name = this.propPathPrefix + name;
            return name;
        };
        /**
         * Subscribe to name so that the property on me with that name will
         * be updated to reflect changes from server through pub-sub.
         */
        BaseController.prototype.subscribe = function (name, optIndex, changeNotification) {
            var _this = this;
            if (optIndex != undefined) {
                this.pubSub.subscribe(this.augmentName(name) + optIndex, {
                    dataReceived: function (newValue) {
                        _this[name][optIndex] = newValue;
                        if (changeNotification)
                            changeNotification(newValue);
                        _this.$scope.$apply();
                    }
                });
            }
            else {
                this.pubSub.subscribe(this.augmentName(name), {
                    dataReceived: function (newValue) {
                        _this[name] = newValue;
                        if (changeNotification)
                            changeNotification(newValue);
                        _this.$scope.$apply();
                    }
                });
            }
        };
        /**
         * Add amount to property with specified name, through pub-sub.
         * Either specify index and amount (for indexed property) else
         * just amount.
         */
        BaseController.prototype.addTo = function (name, amountOrIndex, amount) {
            if (amount !== undefined)
                this.pubSub.add(this.augmentName(name) + amountOrIndex, amount);
            else
                this.pubSub.add(this.augmentName(name), amountOrIndex);
        };
        BaseController.prototype.set = function (name, valueOrIndex, value) {
            if (value !== undefined)
                this.pubSub.set(this.augmentName(name) + valueOrIndex, value);
            else
                this.pubSub.set(this.augmentName(name), valueOrIndex);
        };
        /**
         * Tell registered listener something.
         */
        BaseController.prototype.tell = function (listener, what) {
            this.pubSub.tell(this.augmentName(listener), what);
        };
        return BaseController;
    }());
    exports.BaseController = BaseController;
});
//# sourceMappingURL=BaseController.js.map