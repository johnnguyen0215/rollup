import * as acorn from 'acorn';
import GlobalScope from './ast/scopes/GlobalScope';
import { PathTracker } from './ast/utils/PathTracker';
import Chunk from './Chunk';
import ExternalModule from './ExternalModule';
import Module from './Module';
import { ModuleLoader, UnresolvedModule } from './ModuleLoader';
import {
	ModuleInfo,
	ModuleJSON,
	NormalizedInputOptions,
	RollupCache,
	RollupWatcher,
	SerializablePluginCache
} from './rollup/types';
import { BuildPhase } from './utils/buildPhase';
import { getChunkAssignments } from './utils/chunkAssignment';
import { errImplicitDependantIsNotIncluded, error } from './utils/error';
import { analyseModuleExecution, sortByExecutionOrder } from './utils/executionOrder';
import { getId } from './utils/getId';
import { PluginDriver } from './utils/PluginDriver';
import relativeId from './utils/relativeId';
import { timeEnd, timeStart } from './utils/timers';
import { markModuleAndImpureDependenciesAsExecuted } from './utils/traverseStaticDependencies';

function normalizeEntryModules(
	entryModules: string[] | Record<string, string>
): UnresolvedModule[] {
	if (Array.isArray(entryModules)) {
		return entryModules.map(id => ({
			fileName: null,
			id,
			implicitlyLoadedAfter: [],
			importer: undefined,
			name: null
		}));
	}
	return Object.keys(entryModules).map(name => ({
		fileName: null,
		id: entryModules[name],
		implicitlyLoadedAfter: [],
		importer: undefined,
		name
	}));
}

export default class Graph {
	acornParser: typeof acorn.Parser;
	cachedModules: Map<string, ModuleJSON>;
	contextParse: (code: string, acornOptions?: acorn.Options) => acorn.Node;
	deoptimizationTracker: PathTracker;
	moduleLoader: ModuleLoader;
	modulesById = new Map<string, Module | ExternalModule>();
	needsTreeshakingPass = false;
	phase: BuildPhase = BuildPhase.LOAD_AND_PARSE;
	pluginDriver: PluginDriver;
	scope: GlobalScope;
	watchFiles: Record<string, true> = Object.create(null);
	watchMode = false;

	private entryModules: Module[] = [];
	private externalModules: ExternalModule[] = [];
	private implicitEntryModules: Module[] = [];
	private manualChunkAliasByModule = new Map<Module, string>();
	private manualChunkModulesByAlias: Record<string, Module[]> = {};
	private modules: Module[] = [];
	private pluginCache?: Record<string, SerializablePluginCache>;

	constructor(
		private readonly options: NormalizedInputOptions,
		private readonly unsetOptions: Set<string>,
		watcher: RollupWatcher | null
	) {
		this.deoptimizationTracker = new PathTracker();
		this.cachedModules = new Map();
		if (options.cache !== false) {
			if (options.cache?.modules) {
				for (const module of options.cache.modules) this.cachedModules.set(module.id, module);
			}
			this.pluginCache = options.cache?.plugins || Object.create(null);

			// increment access counter
			for (const name in this.pluginCache) {
				const cache = this.pluginCache[name];
				for (const key of Object.keys(cache)) cache[key][0]++;
			}
		}
		this.contextParse = (code: string, options: acorn.Options = {}) =>
			this.acornParser.parse(code, {
				...this.options.acorn,
				...options
			});

		if (watcher) {
			this.watchMode = true;
			const handleChange = (id: string) => this.pluginDriver.hookSeqSync('watchChange', [id]);
			watcher.on('change', handleChange);
			watcher.once('restart', () => {
				watcher.removeListener('change', handleChange);
			});
		}
		this.pluginDriver = new PluginDriver(this, options, options.plugins, this.pluginCache);
		this.scope = new GlobalScope();
		this.acornParser = acorn.Parser.extend(...(options.acornInjectPlugins as any));
		this.moduleLoader = new ModuleLoader(this, this.modulesById, this.options, this.pluginDriver);
	}

	async build(): Promise<void> {
		timeStart('generate module graph', 2);
		await this.generateModuleGraph();
		timeEnd('generate module graph', 2);

		timeStart('link and order modules', 2);
		this.phase = BuildPhase.ANALYSE;
		this.linkAndOrderModules();
		timeEnd('link and order modules', 2);

		timeStart('mark included statements', 2);
		this.includeStatements();
		timeEnd('mark included statements', 2);

		this.phase = BuildPhase.GENERATE;
	}

	generateChunks(facadeChunkByModule: Map<Module, Chunk>): Chunk[] {
		const chunks: Chunk[] = [];
		const chunkByModule = new Map<Module, Chunk>();
		if (this.options.preserveModules) {
			for (const module of this.modules) {
				if (
					module.isIncluded() ||
					module.isEntryPoint ||
					module.includedDynamicImporters.length > 0
				) {
					const chunk = new Chunk(
						[module],
						this.options,
						this.unsetOptions,
						this.modulesById,
						chunkByModule,
						facadeChunkByModule,
						null
					);
					chunk.entryModules = [module];
					chunks.push(chunk);
					chunkByModule.set(module, chunk);
				}
			}
		} else {
			// TODO Lukas even better, the chunks could be objects with optional aliases
			const { chunks: chunkedModules, manualChunks: modulesByManualChunk } = this.options
				.inlineDynamicImports
				? { chunks: [this.modules], manualChunks: {} }
				: getChunkAssignments(
						this.entryModules,
						this.manualChunkModulesByAlias,
						this.manualChunkAliasByModule
				  );
			for (const chunkModules of chunkedModules) {
				sortByExecutionOrder(chunkModules);
				const chunk = new Chunk(
					chunkModules,
					this.options,
					this.unsetOptions,
					this.modulesById,
					chunkByModule,
					facadeChunkByModule,
					null
				);
				chunks.push(chunk);
				for (const module of chunkModules) {
					chunkByModule.set(module, chunk);
				}
			}
			for (const alias of Object.keys(modulesByManualChunk)) {
				const chunkModules = modulesByManualChunk[alias];
				sortByExecutionOrder(chunkModules);
				const chunk = new Chunk(
					chunkModules,
					this.options,
					this.unsetOptions,
					this.modulesById,
					chunkByModule,
					facadeChunkByModule,
					alias
				);
				chunks.push(chunk);
				for (const module of chunkModules) {
					chunkByModule.set(module, chunk);
				}
			}
		}

		for (const chunk of chunks) {
			chunk.link();
		}
		const facades: Chunk[] = [];
		for (const chunk of chunks) {
			facades.push(...chunk.generateFacades());
		}
		return [...chunks, ...facades];
	}

	getCache(): RollupCache {
		// handle plugin cache eviction
		for (const name in this.pluginCache) {
			const cache = this.pluginCache[name];
			let allDeleted = true;
			for (const key of Object.keys(cache)) {
				if (cache[key][0] >= this.options.experimentalCacheExpiry) delete cache[key];
				else allDeleted = false;
			}
			if (allDeleted) delete this.pluginCache[name];
		}

		return {
			modules: this.modules.map(module => module.toJSON()),
			plugins: this.pluginCache
		};
	}

	getModuleInfo = (moduleId: string): ModuleInfo => {
		const foundModule = this.modulesById.get(moduleId);
		if (foundModule == null) {
			throw new Error(`Unable to find module ${moduleId}`);
		}
		const importedIds: string[] = [];
		const dynamicallyImportedIds: string[] = [];
		if (foundModule instanceof Module) {
			for (const source of foundModule.sources) {
				importedIds.push(foundModule.resolvedIds[source].id);
			}
			for (const { resolution } of foundModule.dynamicImports) {
				if (resolution instanceof Module || resolution instanceof ExternalModule) {
					dynamicallyImportedIds.push(resolution.id);
				}
			}
		}
		return {
			dynamicallyImportedIds,
			dynamicImporters: foundModule.dynamicImporters.sort(),
			hasModuleSideEffects: foundModule.moduleSideEffects,
			id: foundModule.id,
			implicitlyLoadedAfterOneOf:
				foundModule instanceof Module ? Array.from(foundModule.implicitlyLoadedAfter, getId) : [],
			implicitlyLoadedBefore:
				foundModule instanceof Module ? Array.from(foundModule.implicitlyLoadedBefore, getId) : [],
			importedIds,
			importers: foundModule.importers.sort(),
			isEntry: foundModule instanceof Module && foundModule.isEntryPoint,
			isExternal: foundModule instanceof ExternalModule
		};
	};

	private async generateModuleGraph(): Promise<void> {
		const { manualChunks } = this.options;
		[
			{
				entryModules: this.entryModules,
				implicitEntryModules: this.implicitEntryModules,
				manualChunkAliasByModule: this.manualChunkAliasByModule,
				manualChunkModulesByAlias: this.manualChunkModulesByAlias
			}
		] = await Promise.all([
			this.moduleLoader.addEntryModules(normalizeEntryModules(this.options.input), true),
			typeof manualChunks === 'object' ? this.moduleLoader.addManualChunks(manualChunks) : null
		]);
		if (typeof manualChunks === 'function') {
			this.moduleLoader.assignManualChunks(manualChunks);
		}
		if (this.entryModules.length === 0) {
			throw new Error('You must supply options.input to rollup');
		}
		for (const module of this.modulesById.values()) {
			if (module instanceof Module) {
				this.modules.push(module);
			} else {
				this.externalModules.push(module);
			}
		}
	}

	private includeStatements() {
		for (const module of [...this.entryModules, ...this.implicitEntryModules]) {
			if (module.preserveSignature !== false) {
				module.includeAllExports();
			} else {
				markModuleAndImpureDependenciesAsExecuted(module);
			}
		}
		if (this.options.treeshake) {
			let treeshakingPass = 1;
			do {
				timeStart(`treeshaking pass ${treeshakingPass}`, 3);
				this.needsTreeshakingPass = false;
				for (const module of this.modules) {
					if (module.isExecuted) module.include();
				}
				timeEnd(`treeshaking pass ${treeshakingPass++}`, 3);
			} while (this.needsTreeshakingPass);
		} else {
			for (const module of this.modules) module.includeAllInBundle();
		}
		for (const externalModule of this.externalModules) externalModule.warnUnusedImports();
		for (const module of this.implicitEntryModules) {
			for (const dependant of module.implicitlyLoadedAfter) {
				if (!(dependant.isEntryPoint || dependant.isIncluded())) {
					error(errImplicitDependantIsNotIncluded(dependant));
				}
			}
		}
	}

	private linkAndOrderModules() {
		for (const module of this.modules) {
			module.linkDependencies();
		}
		const { orderedModules, cyclePaths } = analyseModuleExecution(this.entryModules);
		for (const cyclePath of cyclePaths) {
			this.options.onwarn({
				code: 'CIRCULAR_DEPENDENCY',
				cycle: cyclePath,
				importer: cyclePath[0],
				message: `Circular dependency: ${cyclePath.join(' -> ')}`
			});
		}
		this.modules = orderedModules;
		for (const module of this.modules) {
			module.bindReferences();
		}
		this.warnForMissingExports();
	}

	private warnForMissingExports() {
		for (const module of this.modules) {
			for (const importName of Object.keys(module.importDescriptions)) {
				const importDescription = module.importDescriptions[importName];
				if (
					importDescription.name !== '*' &&
					!(importDescription.module as Module).getVariableForExportName(importDescription.name)
				) {
					module.warn(
						{
							code: 'NON_EXISTENT_EXPORT',
							message: `Non-existent export '${
								importDescription.name
							}' is imported from ${relativeId((importDescription.module as Module).id)}`,
							name: importDescription.name,
							source: (importDescription.module as Module).id
						},
						importDescription.start
					);
				}
			}
		}
	}
}
