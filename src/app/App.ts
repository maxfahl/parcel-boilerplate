import { PubSubPeer } from "./control/PubSubPeer";


export class App {

	private mTarget: string;
	// private mConnected: boolean = true; // Needs to start as true to not mess up auto loading of blocks on re-connect
	private mContainer: HTMLDivElement;
	private mTabButtons: HTMLDivElement[];
	private mLists: HTMLDivElement[];
	private mControlPanes: HTMLDivElement[];
	private mEnablePaneTimeout: number;
	private mPresentationStepperButtons: HTMLDivElement[];
	private mMoviesJumpButtons: HTMLDivElement[];
	private mMoviesPlayPauseButtons: HTMLDivElement[];
	private mReloadButton: HTMLDivElement;
	private mPubSub: PubSubPeer;
	private mFileNameToClass: any = {
		'presentations': {},
		'movies': {}
	};
	private mLastSelectedItem: HTMLDivElement;
	private mCurrentFile: string;
	private mCurrentProgram: string;
	private mFirstMarkCurrentListItem = true;

	constructor() {
		this.init();
	}

	private init(): void {
		this.mTarget = this.getUrlParameter('target');
		this.mPubSub = new PubSubPeer();

		this.mContainer = document.querySelector('#wrapper .inner');
		// this.mContainer.querySelector('.disconnected-message').innerHTML = `<p>Lost connection to ${ this.mTarget }</p>`;
		this.mTabButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.tabs .buttons .button')
		);
		this.mTabButtons.forEach(buttonEl => {
			buttonEl.addEventListener(
				'click',
				(e) => this.onTabButtonClick(<HTMLDivElement>e.target, true)
			);
		});
		this.mLists = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.tabs .content .list')
		);
		this.mControlPanes = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.controls .pane')
		);
		this.mPresentationStepperButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.controls .pane.presentations .stepper')
		);
		this.mPresentationStepperButtons.forEach(button => {
			button.addEventListener('click', () => this.onPresentationStepButtonClick(button));
		});
		this.mMoviesJumpButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.controls .pane.movies .jump')
		);
		this.mMoviesJumpButtons.forEach(button => {
			button.addEventListener('click', () => this.onMovieJumpButtonClick(button));
		});
		this.mMoviesPlayPauseButtons = Array.prototype.slice.call(
			this.mContainer.querySelectorAll<HTMLDivElement>('.controls .pane.movies .play-pause .button')
		);
		this.mMoviesPlayPauseButtons.forEach(button => {
			button.addEventListener('click', () => this.onMoviesPlayPauseButtonClick(button));
		});
		this.mReloadButton = this.mContainer.querySelector<HTMLDivElement>('.tabs .content .reload-button');
		this.mReloadButton.addEventListener('click', this.onReloadButtonClick.bind(this))

		this.subscribe();
		// this.onTabButtonClick(this.mTabButtons[0]);
	}

	private subscribe() {
		this.mPubSub.subscribe<boolean>(
			`Network.${ this.mTarget }.connected`,
			{
				dataReceived: (connected: boolean) => {
					if (connected) {
						this.mContainer.classList.add('connected');
						this.mContainer.classList.remove('disconnected');
					} else {
						this.mContainer.classList.add('disconnected');
						this.mContainer.classList.remove('connected');
					}
					// if (this.mConnected != connected) {
					// 	this.mConnected = connected;
					// 	if (this.mConnected) {
					// 		this.onTabButtonClick(this.mTabButtons[2]);
					// 		window.setTimeout(() => {
					// 			this.startBlocks();
					// 		},500);
					// 	}
					// }
				}
			}
		);
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
					this.markCurrentListItem();

				}
			}
		);
		this.mPubSub.subscribe<string>(
			`Network.${ this.mTarget }.program`,
			{
				dataReceived: (currentProgram: string) => {
					this.mCurrentProgram = currentProgram;
				}
			}
		);
		this.mPubSub.subscribe<boolean>(
			`Realm.Main.variable.${ this.mTarget }MoviePlaying.value`,
			{
				dataReceived: (playing: boolean) => {
					this.onMoviePlayStateChange(playing);
				}
			}
		);
	}

	private onTabButtonClick(
		selectedButton: HTMLDivElement,
		userClick: boolean = false
	): void {
		this.mTabButtons.forEach(buttonEl => buttonEl.classList.remove('active'));
		this.mLists.forEach(buttonEl => buttonEl.classList.remove('visible'));
		const wantedType = selectedButton.dataset['type'];
		const list = wantedType === 'presentations' ? this.mLists[0] : (wantedType === 'movies' ? this.mLists[1] : this.mLists[2]);

		selectedButton.classList.add('active');
		list.classList.add('visible');

		this.mReloadButton.style.display = wantedType !== 'blocks' ? 'block' : 'none';

		this.mContainer.querySelectorAll('.controls .pane').forEach(pane => pane.classList.remove('visible'));
		this.mContainer.querySelector(`.controls .pane.${ wantedType }`).classList.add('visible');

		if (userClick && wantedType === 'blocks') {
			this.startBlocksIfNotRunning(true);
		}
	}

	private startBlocksIfNotRunning(force: boolean = false): void {
		if (force || this.mCurrentProgram.indexOf('chrome.exe') === -1) {
			if (force || this.mCurrentFile)
				this.setCurrentFile('');
			this.startBlocks();
		}
	}

	private startBlocks(): void {
		this.mPubSub.set(
			`Network.${ this.mTarget }.program`,
			'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe|C:\\Program Files (x86)\\Google\\Chrome\\Application|--kiosk --no-startup-window --disable-features=TranslateUI --autoplay-policy=no-user-gesture-required --app=http://10.0.1.157:9080/spot'
		);
	}

	private markCurrentListItem() {
		let className: string;
		let inPresentations = true;
		if (this.mCurrentFile) {
			className = this.mFileNameToClass['presentations'][this.mCurrentFile];
			if (!className) {
				className = this.mFileNameToClass['movies'][this.mCurrentFile];
				inPresentations = false;
			}
		}
		let listItemToSelect = className ? this.mContainer.querySelector<HTMLDivElement>(`.tabs .content .${ className }`) : null;
		if (this.mLastSelectedItem && this.mLastSelectedItem !== listItemToSelect)
			this.mLastSelectedItem.classList.remove('selected');
		if (this.mEnablePaneTimeout) {
			window.clearTimeout(this.mEnablePaneTimeout);
			this.mEnablePaneTimeout = undefined;
		}
		this.mControlPanes.forEach(pane => pane.classList.remove('enabled'));
		if (listItemToSelect) {
			listItemToSelect.classList.add('selected');
			this.mLastSelectedItem = listItemToSelect;
			this.onTabButtonClick(inPresentations ? this.mTabButtons[0] : this.mTabButtons[1]);
			const paneToEnable = inPresentations ? this.mControlPanes[0] : this.mControlPanes[1];
			// if (inPresentations) {
			// 	paneToEnable.classList.add('enabled');
			// } else {
			this.mEnablePaneTimeout = window.setTimeout(() => {
				paneToEnable.classList.add('enabled');
			}, 1000)
			// }
		} else if (this.mFirstMarkCurrentListItem) {
			this.mFirstMarkCurrentListItem = false;
			this.onTabButtonClick(this.mTabButtons[2]);
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
		this.mPubSub.set(`Realm.Main.variable.${ this.mTarget }MoviePlaying.value`, false);

		if (this.mCurrentFile === fileName) {
			// this.setCurrentFile('');
			this.startBlocksIfNotRunning();
		} else {
			this.setCurrentFile(fileName);
			this.resetMoviesPlayPauseButton();
			if (listItem.parentElement.classList.contains('movies'))
				this.mPubSub.set(`Realm.Main.variable.${ this.mTarget }MoviePlaying.value`, true);
		}
	}

	private setCurrentFile(fileName: string): void {
		this.mPubSub.set(`Network.${ this.mTarget }.currFile`, fileName);
	}

	private onPresentationStepButtonClick(button: HTMLDivElement) {
		let next = button.classList.contains('next');
		this.mPubSub.set(`Network.${ this.mTarget }.keyDown`, next ? 'VK_RIGHT' : 'VK_LEFT');
	}

	private onMovieJumpButtonClick(button: HTMLDivElement): void {
		let next = button.classList.contains('forward');
		this.mPubSub.set(`Network.${ this.mTarget }.keyDown`, next ? 'alt+VK_S' : 'alt+VK_A');
	}

	private onMoviesPlayPauseButtonClick(button: HTMLDivElement): void {
		let doPause = button.classList.contains('pause');
		this.setMoviePlatingState(doPause);
		// this.mPubSub.set(`Network.${ this.mTarget }.keyDown`, 'control+P'); // WMP
		this.mPubSub.set(`Network.${ this.mTarget }.keyDown`, 'VK_SPACE');
	}

	private setMoviePlatingState(playing: boolean): void {
		this.mPubSub.set(`Realm.Main.variable.${ this.mTarget }MoviePlaying.value`, playing);
	}

	private onMoviePlayStateChange(playing: boolean) {
		if (playing) {
			this.mMoviesPlayPauseButtons[0].classList.remove('visible');
			this.mMoviesPlayPauseButtons[1].classList.add('visible');
		} else {
			this.mMoviesPlayPauseButtons[0].classList.add('visible');
			this.mMoviesPlayPauseButtons[1].classList.remove('visible');
		}
	}

	private resetMoviesPlayPauseButton(): void {
		this.mMoviesPlayPauseButtons[0].classList.remove('visible');
		this.mMoviesPlayPauseButtons[1].classList.add('visible');
	}

	private onReloadButtonClick(): void {
		this.mPubSub.set(`Network.${ this.mTarget }.refresh`, true);
		this.mReloadButton.classList.add('loading');
		window.setTimeout(() => {
			this.mReloadButton.classList.remove('loading');
		}, 1000);
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
