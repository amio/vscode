/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalCapability, type ITerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { GeneralShellType, TerminalShellType } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalSuggestSettingId } from '../common/terminalSuggestConfiguration.js';
import { TerminalCompletionItemKind, type ITerminalCompletion } from './terminalCompletionItem.js';

export const ITerminalCompletionService = createDecorator<ITerminalCompletionService>('terminalCompletionService');

/**
 * Represents a collection of {@link CompletionItem completion items} to be presented
 * in the terminal.
 */
export class TerminalCompletionList<ITerminalCompletion> {

	/**
	 * Resources should be shown in the completions list
	 */
	resourceRequestConfig?: TerminalResourceRequestConfig;

	/**
	 * The completion items.
	 */
	items?: ITerminalCompletion[];

	/**
	 * Creates a new completion list.
	 *
	 * @param items The completion items.
	 * @param isIncomplete The list is not complete.
	 */
	constructor(items?: ITerminalCompletion[], resourceRequestConfig?: TerminalResourceRequestConfig) {
		this.items = items;
		this.resourceRequestConfig = resourceRequestConfig;
	}
}

export interface TerminalResourceRequestConfig {
	filesRequested?: boolean;
	foldersRequested?: boolean;
	cwd?: UriComponents;
	pathSeparator: string;
	env?: { [key: string]: string | null | undefined };
}


export interface ITerminalCompletionProvider {
	id: string;
	shellTypes?: TerminalShellType[];
	provideCompletions(value: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | TerminalCompletionList<ITerminalCompletion> | undefined>;
	triggerCharacters?: string[];
	isBuiltin?: boolean;
}

export interface ITerminalCompletionService {
	_serviceBrand: undefined;
	readonly providers: IterableIterator<ITerminalCompletionProvider>;
	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable;
	provideCompletions(promptValue: string, cursorPosition: number, shellType: TerminalShellType, capabilities: ITerminalCapabilityStore, token: CancellationToken, triggerCharacter?: boolean, skipExtensionCompletions?: boolean): Promise<ITerminalCompletion[] | undefined>;
}

export class TerminalCompletionService extends Disposable implements ITerminalCompletionService {
	declare _serviceBrand: undefined;
	private readonly _providers: Map</*ext id*/string, Map</*provider id*/string, ITerminalCompletionProvider>> = new Map();

	get providers(): IterableIterator<ITerminalCompletionProvider> {
		return this._providersGenerator();
	}

	private *_providersGenerator(): IterableIterator<ITerminalCompletionProvider> {
		for (const providerMap of this._providers.values()) {
			for (const provider of providerMap.values()) {
				yield provider;
			}
		}
	}

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService
	) {
		super();
	}

	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable {
		let extMap = this._providers.get(extensionIdentifier);
		if (!extMap) {
			extMap = new Map();
			this._providers.set(extensionIdentifier, extMap);
		}
		provider.triggerCharacters = triggerCharacters;
		provider.id = id;
		extMap.set(id, provider);
		return toDisposable(() => {
			const extMap = this._providers.get(extensionIdentifier);
			if (extMap) {
				extMap.delete(id);
				if (extMap.size === 0) {
					this._providers.delete(extensionIdentifier);
				}
			}
		});
	}

	async provideCompletions(promptValue: string, cursorPosition: number, shellType: TerminalShellType, capabilities: ITerminalCapabilityStore, token: CancellationToken, triggerCharacter?: boolean, skipExtensionCompletions?: boolean): Promise<ITerminalCompletion[] | undefined> {
		if (!this._providers || !this._providers.values || cursorPosition < 0) {
			return undefined;
		}

		let providers;
		if (triggerCharacter) {
			const providersToRequest: ITerminalCompletionProvider[] = [];
			for (const provider of this.providers) {
				if (!provider.triggerCharacters) {
					continue;
				}
				for (const char of provider.triggerCharacters) {
					if (promptValue.substring(0, cursorPosition)?.endsWith(char)) {
						providersToRequest.push(provider);
						break;
					}
				}
			}
			providers = providersToRequest;
		} else {
			providers = [...this._providers.values()].flatMap(providerMap => [...providerMap.values()]);
		}

		if (skipExtensionCompletions) {
			providers = providers.filter(p => p.isBuiltin);
			return this._collectCompletions(providers, shellType, promptValue, cursorPosition, capabilities, token);
		}

		const providerConfig: { [key: string]: boolean } = this._configurationService.getValue(TerminalSuggestSettingId.Providers);
		providers = providers.filter(p => {
			const providerId = p.id;
			return providerId && providerId in providerConfig && providerConfig[providerId] !== false;
		});

		if (!providers.length) {
			return;
		}

		return this._collectCompletions(providers, shellType, promptValue, cursorPosition, capabilities, token);
	}

	private async _collectCompletions(providers: ITerminalCompletionProvider[], shellType: TerminalShellType, promptValue: string, cursorPosition: number, capabilities: ITerminalCapabilityStore, token: CancellationToken): Promise<ITerminalCompletion[] | undefined> {
		const completionPromises = providers.map(async provider => {
			if (provider.shellTypes && !provider.shellTypes.includes(shellType)) {
				return undefined;
			}
			const completions: ITerminalCompletion[] | TerminalCompletionList<ITerminalCompletion> | undefined = await provider.provideCompletions(promptValue, cursorPosition, token);
			if (!completions) {
				return undefined;
			}
			const completionItems = Array.isArray(completions) ? completions : completions.items ?? [];
			if (shellType === GeneralShellType.PowerShell) {
				for (const completion of completionItems) {
					completion.isFileOverride ??= completion.kind === TerminalCompletionItemKind.Method && completion.replacementIndex === 0;
				}
			}
			if (provider.isBuiltin) {
				//TODO: why is this needed?
				for (const item of completionItems) {
					item.provider = provider.id;
				}
			}
			if (Array.isArray(completions)) {
				return completionItems;
			}
			if (completions.resourceRequestConfig) {
				const resourceCompletions = await this.resolveResources(completions.resourceRequestConfig, promptValue, cursorPosition, provider.id, capabilities);
				if (resourceCompletions) {
					completionItems.push(...resourceCompletions);
				}
				return completionItems;
			}
			return;
		});

		const results = await Promise.all(completionPromises);
		return results.filter(result => !!result).flat();
	}

	async resolveResources(resourceRequestConfig: TerminalResourceRequestConfig, promptValue: string, cursorPosition: number, provider: string, capabilities: ITerminalCapabilityStore): Promise<ITerminalCompletion[] | undefined> {
		const useWindowsStylePath = resourceRequestConfig.pathSeparator === '\\';
		if (useWindowsStylePath) {
			// for tests, make sure the right path separator is used
			promptValue = promptValue.replaceAll(/[\\/]/g, resourceRequestConfig.pathSeparator);
		}
		const cwd = URI.revive(resourceRequestConfig.cwd);
		const foldersRequested = resourceRequestConfig.foldersRequested ?? false;
		const filesRequested = resourceRequestConfig.filesRequested ?? false;
		if (!cwd || (!foldersRequested && !filesRequested)) {
			return;
		}

		const resourceCompletions: ITerminalCompletion[] = [];
		const cursorPrefix = promptValue.substring(0, cursorPosition);


		// The last word (or argument). When the cursor is following a space it will be the empty
		// string
		const lastWord = cursorPrefix.endsWith(' ') ? '' : cursorPrefix.split(' ').at(-1) ?? '';

		// Get the nearest folder path from the prefix. This ignores everything after the `/` as
		// they are what triggers changes in the directory.
		let lastSlashIndex: number;
		if (useWindowsStylePath) {
			lastSlashIndex = Math.max(lastWord.lastIndexOf('\\'), lastWord.lastIndexOf('/'));
		} else {
			lastSlashIndex = lastWord.lastIndexOf(resourceRequestConfig.pathSeparator);
		}

		// The _complete_ folder of the last word. For example if the last word is `./src/file`,
		// this will be `./src/`. This also always ends in the path separator if it is not the empty
		// string and path separators are normalized on Windows.
		let lastWordFolder = lastSlashIndex === -1 ? '' : lastWord.slice(0, lastSlashIndex + 1);
		if (useWindowsStylePath) {
			lastWordFolder = lastWordFolder.replaceAll('/', '\\');
		}


		// Determine the current folder being shown
		let lastWordFolderResource: URI | string | undefined;
		const lastWordFolderHasDotPrefix = !!lastWordFolder.match(/^\.\.?[\\\/]/);
		const lastWordFolderHasTildePrefix = lastWordFolder.match(/^~[\\\/]/);
		const isAbsolutePath = useWindowsStylePath
			? /^[a-zA-Z]:[\\\/]/.test(lastWord)
			: lastWord.startsWith(resourceRequestConfig.pathSeparator);
		const type = lastWordFolderHasTildePrefix ? 'tilde' : isAbsolutePath ? 'absolute' : 'relative';
		switch (type) {
			case 'tilde': {
				const env = capabilities.get(TerminalCapability.ShellEnvDetection)?.env;
				if (env) {
					const home = useWindowsStylePath ? env.get('USERPROFILE') : env.get('HOME');
					// TODO: Handle the case where the HOME environment variable is not set
					if (home) {
						lastWordFolderResource = URI.joinPath(URI.file(home), lastWordFolder.slice(1));
					}
				}
				if (!lastWordFolderResource) {
					// Use less strong wording here as it's not as strong of a concept on Windows
					// and could be misleading
					lastWordFolderResource = useWindowsStylePath ? 'Home directory' : '$HOME';
				}
				break;
			}
			case 'absolute': {
				lastWordFolderResource = URI.file(lastWordFolder);
				break;
			}
			case 'relative': {
				lastWordFolderResource = cwd;
				break;
			}
		}

		// Assemble completions based on the resource of lastWordFolder. Note that on Windows the
		// path seprators are normalized to `\`:
		// - `./src/|` -> `.\src\`
		if (!lastWordFolderResource) {
			return undefined;
		}

		// Early exit with basic completion if we don't know the resource
		if (typeof lastWordFolderResource === 'string') {
			resourceCompletions.push({
				label: lastWordFolder,
				provider,
				kind: TerminalCompletionItemKind.Folder,
				detail: lastWordFolderResource,
				replacementIndex: cursorPosition - lastWord.length,
				replacementLength: lastWord.length
			});
			return resourceCompletions;
		}

		const stat = await this._fileService.resolve(lastWordFolderResource, { resolveSingleChildDescendants: true });
		if (!stat?.children) {
			return;
		}

		// Add current directory. This should be shown at the top because it will be an exact
		// match and therefore highlight the detail, plus it improves the experience when
		// runOnEnter is used.
		//
		// For example:
		// - (relative) `|`       -> `.`
		//   this does not have the trailing `/` intentionally as it's common to complete the
		//   current working directory and we do not want to complete `./` when `runOnEnter` is
		//   used.
		// - (relative) `./src/|` -> `./src/`
		// - (absolute) `/src/|`  -> `/src/`
		// - (tilde)    `~/|`     -> `~/`
		// - (tilde)    `~/src/|` -> `~/src/`
		if (foldersRequested) {
			let label: string;
			switch (type) {
				case 'tilde': {
					label = lastWordFolder;
					break;
				}
				case 'absolute': {
					label = lastWordFolder;
					break;
				}
				case 'relative': {
					label = '.';
					if (lastWordFolder.length > 0) {
						label = addPathRelativePrefix(lastWordFolder, resourceRequestConfig, lastWordFolderHasDotPrefix);
					}
					break;
				}
			}

			resourceCompletions.push({
				label,
				provider,
				kind: TerminalCompletionItemKind.Folder,
				detail: getFriendlyPath(lastWordFolderResource, resourceRequestConfig.pathSeparator, TerminalCompletionItemKind.Folder),
				replacementIndex: cursorPosition - lastWord.length,
				replacementLength: lastWord.length
			});
		}

		// Add all direct children files or folders
		//
		// For example:
		// - (relative) `cd ./src/`  -> `cd ./src/folder1/`, ...
		// - (absolute) `cd c:/src/` -> `cd c:/src/folder1/`, ...
		// - (tilde)    `cd ~/src/`  -> `cd ~/src/folder1/`, ...
		for (const child of stat.children) {
			let kind: TerminalCompletionItemKind | undefined;
			if (foldersRequested && child.isDirectory) {
				kind = TerminalCompletionItemKind.Folder;
			} else if (filesRequested && child.isFile) {
				kind = TerminalCompletionItemKind.File;
			}
			if (kind === undefined) {
				continue;
			}

			let label = lastWordFolder;
			if (label.length > 0 && !label.endsWith(resourceRequestConfig.pathSeparator)) {
				label += resourceRequestConfig.pathSeparator;
			}
			label += child.name;
			if (type === 'relative') {
				label = addPathRelativePrefix(label, resourceRequestConfig, lastWordFolderHasDotPrefix);
			}
			if (child.isDirectory && !label.endsWith(resourceRequestConfig.pathSeparator)) {
				label += resourceRequestConfig.pathSeparator;
			}

			resourceCompletions.push({
				label,
				provider,
				kind,
				detail: getFriendlyPath(child.resource, resourceRequestConfig.pathSeparator, kind),
				replacementIndex: cursorPosition - lastWord.length,
				replacementLength: lastWord.length
			});
		}

		// Support $CDPATH specially for the `cd` command only
		// - (relative) `|` -> `/foo/vscode` (CDPATH has /foo which contains vscode folder)
		if (type === 'relative' && foldersRequested) {
			if (promptValue.startsWith('cd ')) {
				const config = this._configurationService.getValue(TerminalSuggestSettingId.CdPath);
				if (config === 'absolute' || config === 'relative') {
					const cdPath = capabilities.get(TerminalCapability.ShellEnvDetection)?.env?.get('CDPATH');
					if (cdPath) {
						const cdPathEntries = cdPath.split(useWindowsStylePath ? ';' : ':');
						for (const cdPathEntry of cdPathEntries) {
							try {
								const fileStat = await this._fileService.resolve(URI.file(cdPathEntry), { resolveSingleChildDescendants: true });
								if (fileStat?.children) {
									for (const child of fileStat.children) {
										if (!child.isDirectory) {
											continue;
										}
										const useRelative = config === 'relative';
										const kind = TerminalCompletionItemKind.Folder;
										const label = useRelative ? basename(child.resource.fsPath) : getFriendlyPath(child.resource, resourceRequestConfig.pathSeparator, kind);
										const detail = useRelative ? `CDPATH ${getFriendlyPath(child.resource, resourceRequestConfig.pathSeparator, kind)}` : `CDPATH`;
										resourceCompletions.push({
											label,
											provider,
											kind,
											detail,
											replacementIndex: cursorPosition - lastWord.length,
											replacementLength: lastWord.length
										});
									}
								}
							} catch { /* ignore */ }
						}
					}
				}
			}
		}

		// Add parent directory to the bottom of the list because it's not as useful as other suggestions
		//
		// For example:
		// - (relative) `|` -> `../`
		// - (relative) `./src/|` -> `./src/../`
		if (type === 'relative' && foldersRequested) {
			let label = `..${resourceRequestConfig.pathSeparator}`;
			if (lastWordFolder.length > 0) {
				label = addPathRelativePrefix(lastWordFolder + label, resourceRequestConfig, lastWordFolderHasDotPrefix);
			}
			const parentDir = URI.joinPath(cwd, '..' + resourceRequestConfig.pathSeparator);
			resourceCompletions.push({
				label,
				provider,
				kind: TerminalCompletionItemKind.Folder,
				detail: getFriendlyPath(parentDir, resourceRequestConfig.pathSeparator, TerminalCompletionItemKind.Folder),
				replacementIndex: cursorPosition - lastWord.length,
				replacementLength: lastWord.length
			});
		}

		return resourceCompletions;
	}
}

function getFriendlyPath(uri: URI, pathSeparator: string, kind: TerminalCompletionItemKind): string {
	let path = uri.fsPath;
	// Ensure folders end with the path separator to differentiate presentation from files
	if (kind === TerminalCompletionItemKind.Folder && !path.endsWith(pathSeparator)) {
		path += pathSeparator;
	}
	// Ensure drive is capitalized on Windows
	if (pathSeparator === '\\' && path.match(/^[a-zA-Z]:\\/)) {
		path = `${path[0].toUpperCase()}:${path.slice(2)}`;
	}
	return path;
}

/**
 * Normalize suggestion to add a ./ prefix to the start of the path if there isn't one already. We
 * may want to change this behavior in the future to go with whatever format the user has.
 */
function addPathRelativePrefix(text: string, resourceRequestConfig: Pick<TerminalResourceRequestConfig, 'pathSeparator'>, lastWordFolderHasDotPrefix: boolean): string {
	if (!lastWordFolderHasDotPrefix) {
		return `.${resourceRequestConfig.pathSeparator}${text}`;
	}
	return text;
}
