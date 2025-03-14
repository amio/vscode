/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import * as extensionsRegistry from '../../../../services/extensions/common/extensionsRegistry.js';
import { mcpActivationEvent, mcpContributionPoint } from '../mcpConfiguration.js';
import { IMcpRegistry } from '../mcpRegistryTypes.js';
import { extensionMcpCollectionPrefix, extensionPrefixedIdentifier, McpServerDefinition } from '../mcpTypes.js';
import { IMcpDiscovery } from './mcpDiscovery.js';


const cacheKey = 'mcp.extCachedServers';

interface IServerCacheEntry {
	readonly servers: readonly McpServerDefinition.Serialized[];
}

const _mcpExtensionPoint = extensionsRegistry.ExtensionsRegistry.registerExtensionPoint(mcpContributionPoint);

export class ExtensionMcpDiscovery extends Disposable implements IMcpDiscovery {
	private readonly _extensionCollectionIdsToPersist = new Set<string>();
	private readonly cachedServers: { [collcetionId: string]: IServerCacheEntry };

	constructor(
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
		@IStorageService storageService: IStorageService,
		@IExtensionService private readonly _extensionService: IExtensionService,
	) {
		super();
		this.cachedServers = storageService.getObject(cacheKey, StorageScope.WORKSPACE, {});

		this._register(storageService.onWillSaveState(() => {
			let updated = false;
			for (const collectionId of this._extensionCollectionIdsToPersist) {
				const defs = this._mcpRegistry.collections.get().find(c => c.id === collectionId)?.serverDefinitions.get();
				if (defs) {
					updated = true;
					this.cachedServers[collectionId] = { servers: defs.map(McpServerDefinition.toSerialized) };
				}
			}

			if (updated) {
				storageService.store(cacheKey, this.cachedServers, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}));
	}

	public start(): void {
		const extensionCollections = this._register(new DisposableMap<string>());
		_mcpExtensionPoint.setHandler((_extensions, delta) => {
			const { added, removed } = delta;

			for (const collections of removed) {
				for (const coll of collections.value) {
					extensionCollections.deleteAndDispose(extensionPrefixedIdentifier(collections.description.identifier, coll.id));
				}
			}

			for (const collections of added) {
				for (const coll of collections.value) {
					const serverDefs = this.cachedServers.hasOwnProperty(coll.id) ? this.cachedServers[coll.id].servers : undefined;

					const id = extensionPrefixedIdentifier(collections.description.identifier, coll.id);
					const dispo = this._mcpRegistry.registerCollection({
						id,
						label: coll.label,
						remoteAuthority: null,
						isTrustedByDefault: true,
						scope: StorageScope.WORKSPACE,
						serverDefinitions: observableValue<McpServerDefinition[]>(this, serverDefs?.map(McpServerDefinition.fromSerialized) || []),
						lazy: {
							isCached: !!serverDefs,
							load: () => this._activateExtensionServers(coll.id),
							removed: () => extensionCollections.deleteAndDispose(id),
						}
					});

					extensionCollections.set(id, dispo);
				}
			}
		});
	}

	private async _activateExtensionServers(collectionId: string): Promise<void> {
		await this._extensionService.activateByEvent(mcpActivationEvent(collectionId.slice(extensionMcpCollectionPrefix.length)));
		await Promise.all(this._mcpRegistry.delegates
			.map(r => r.waitForInitialProviderPromises()));
	}
}
