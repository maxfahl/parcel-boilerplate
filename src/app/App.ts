

export class App {

	private mContainer: HTMLDivElement;
	private mButtons: HTMLDivElement[];

	constructor() {
		this.init();
	}

	private init(): void {
		this.mContainer = document.querySelector('#wrapper .inner');
		this.mButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.tabs .buttons .button')
		);
		console.log(this.mButtons);
		this.mButtons.forEach(buttonEl => {
			buttonEl.addEventListener('click', (e) => this.onButtonClick(<HTMLDivElement>e.target));
		});
		this.onButtonClick(this.mButtons[0]);
	}

	private onButtonClick(selectedButton: HTMLDivElement): void {
		this.mButtons.forEach(buttonEl => buttonEl.classList.remove('active'));
		selectedButton.classList.add('active');
	}
}
