import { App } from "./app/App";


window.setTimeout(() => {
	(<any>window).app = new App();
}, 200);
