import { PubSubPeer } from "./control/PubSubPeer";


export class App {

	private mTarget: string;
	private mContainer: HTMLDivElement;
	private mButtons: HTMLDivElement[];
	private mLists: HTMLDivElement[];
	private mPubSub: PubSubPeer;
	private mFileNameToClass: any = {
		'presentations': {},
		'movies': {}
	};
	private mLastSelectedItem: HTMLDivElement;
	private mCurrentFile: string;

	constructor() {
		this.init();
	}

	private init(): void {
		this.mTarget = this.getUrlParameter('target');
		this.mPubSub = new PubSubPeer();

		this.mContainer = document.querySelector('#wrapper .inner');
		this.mButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.tabs .buttons .button')
		);
		this.mLists = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.tabs .content .list')
		);
		this.mButtons.forEach(buttonEl => {
			buttonEl.addEventListener('click', (e) => this.onButtonClick(<HTMLDivElement>e.target));
		});

		this.subscribe();

		this.onButtonClick(this.mButtons[0]);
	}

	private subscribe() {
		this.mPubSub.subscribe<string>(
			`Network.${ this.mTarget }.powerpointFiles`,
			{
				dataReceived: (fileStr: string) => {
					this.populateList(
						'presentations',
						fileStr.length ? fileStr.split('|') : []
					);
					this.markCurrentListItem();
				}
			}
		);
		this.mPubSub.subscribe<string>(
			`Network.${ this.mTarget }.videoFiles`,
			{
				dataReceived: (fileStr: string) => {
					this.populateList(
						'movies',
						fileStr.length ? fileStr.split('|') : []
					);
					this.markCurrentListItem();
				}
			}
		);
		this.mPubSub.subscribe<string>(
			`Network.${ this.mTarget }.currFile`,
			{
				dataReceived: (currentFile: string) => {
					this.mCurrentFile = currentFile;
					console.log('File now running on PC: ' + this.mCurrentFile);
					this.markCurrentListItem();
				}
			}
		);
	}

	private onButtonClick(selectedButton: HTMLDivElement): void {
		this.mButtons.forEach(buttonEl => buttonEl.classList.remove('active'));
		this.mLists.forEach(buttonEl => buttonEl.classList.remove('visible'));
		const list = selectedButton.dataset['type'] === 'presentations' ? this.mLists[0] : this.mLists[1];

		selectedButton.classList.add('active');
		list.classList.add('visible');
	}

	private markCurrentListItem() {
		let className: string;
		if (this.mCurrentFile) {
			className = this.mFileNameToClass['presentations'][this.mCurrentFile];
			if (!className)
				className = this.mFileNameToClass['movies'][this.mCurrentFile];
		}
		let listItemToSelect = className ? this.mContainer.querySelector<HTMLDivElement>(`.tabs .content .${ className }`) : null;
		if (this.mLastSelectedItem && this.mLastSelectedItem !== listItemToSelect)
			this.mLastSelectedItem.classList.remove('selected');
		if (listItemToSelect) {
			listItemToSelect.classList.add('selected');
			this.mLastSelectedItem = listItemToSelect;
		}
	}

	private populateList(
		listName: string,
		files: string[]
	) {
		const htmlDivElement = this.getListByName(listName);
		this.mFileNameToClass[listName] = {};

		if (!files.length) {
			htmlDivElement.innerHTML = this.generateListItemEl(`No ${ listName } found...`, 'no-result');
			return;
		}
		let html = '';
		files.forEach((fileName, index) => {
			let className = `${ listName }-${ index + 1 }`;
			this.mFileNameToClass[listName][fileName] = className;
			html += this.generateListItemEl(fileName, className);
		});
		htmlDivElement.innerHTML = html;
		Array.prototype.slice.call(
			htmlDivElement.querySelectorAll<HTMLDivElement>('.list-item')
		).forEach((listItem) => {
			listItem.addEventListener('click', () => {
				this.onListItemClick(listItem);
			});
		});
	}

	private onListItemClick(listItem: HTMLDivElement): void {
		const fileName = listItem.dataset['fileName'];
		if (this.mCurrentFile === fileName) {
			this.mPubSub.set(`Network.${ this.mTarget }.currFile`, '');
		} else {
			this.mPubSub.set(`Network.${ this.mTarget }.currFile`, fileName);
		}
	}

	private generateListItemEl(
		fileName: string,
		className: string
	): string {
		return `<div class="list-item ${ className }" data-file-name="${ fileName }">
			<span class="name">${ fileName }</span>
		</div>`;
	};

	private getListByName(name: string): HTMLDivElement {
		return name === 'presentations' ? this.mLists[0] : this.mLists[1];
	}

	private getUrlParameter(name) {
		name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
		let regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
		let results = regex.exec(location.search);
		return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
	};
}
