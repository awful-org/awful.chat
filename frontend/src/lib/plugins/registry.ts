/**
 * Plugin registry and loader.
 * Manifests loaded eagerly at boot, plugin code loaded lazily on first use.
 */

import {
  HOST_FEATURES,
  type PluginDefinition,
  type PluginManifest,
} from "./api";
import { validatePluginId } from "./validate";

interface ManifestModule {
  manifest: PluginManifest;
}

interface PluginModule {
  default: PluginDefinition;
}

// Eager load all manifests at boot
const manifestGlob = import.meta.glob<ManifestModule>(
  "../../../plugins/*/manifest.ts",
  { eager: true }
);

// Lazy load plugin code on first use
const pluginGlob = import.meta.glob<PluginModule>(
  "../../../plugins/*/index.ts"
);

interface RegisteredPlugin {
  manifest: PluginManifest;
  loaded: boolean;
  definition?: PluginDefinition;
}

const registry = new Map<string, RegisteredPlugin>();
const loadPromises = new Map<string, Promise<PluginDefinition | null>>();

// Load and validate manifests at startup
export function initializeRegistry(): void {
  const seenIds = new Set<string>();

  for (const [path, mod] of Object.entries(manifestGlob)) {
    try {
      const manifest = mod.manifest;

      // Validate manifest structure
      if (!manifest.id || typeof manifest.id !== "string") {
        console.error(`[plugins] manifest at ${path} missing id`);
        continue;
      }

      if (!manifest.name || typeof manifest.name !== "string") {
        console.error(`[plugins] manifest ${manifest.id} missing name`);
        continue;
      }

      if (!manifest.description || typeof manifest.description !== "string") {
        console.error(`[plugins] manifest ${manifest.id} missing description`);
        continue;
      }

      if (!manifest.icon || typeof manifest.icon !== "string") {
        console.error(`[plugins] manifest ${manifest.id} missing icon`);
        continue;
      }

      if (manifest.apiVersion !== 1) {
        console.error(
          `[plugins] manifest ${manifest.id} apiVersion ${manifest.apiVersion} not supported (want 1)`
        );
        continue;
      }

      // Validate plugin ID format
      const idValidation = validatePluginId(manifest.id);
      if (!idValidation.ok) {
        console.error(
          `[plugins] manifest ${manifest.id} id validation failed: ${idValidation.reason}`
        );
        continue;
      }

      // Check for duplicates
      if (seenIds.has(manifest.id)) {
        console.error(`[plugins] duplicate plugin id: ${manifest.id}`);
        continue;
      }

      seenIds.add(manifest.id);
      registry.set(manifest.id, { manifest, loaded: false });
    } catch (err) {
      console.error(`[plugins] failed to load manifest from ${path}:`, err);
    }
  }
}

// Lazy-load plugin definition on first access
/**
 * Manifest `requires` entries this host build cannot satisfy. Non-empty
 * means the plugin must not LOAD: executing code that assumes a missing
 * host API crashes at some later, confusing moment; refusing up front with
 * the feature names is the graceful degradation the field exists for.
 */
export function unsupportedRequirements(
  manifest: PluginManifest | null
): string[] {
  if (!manifest?.requires) return [];
  return manifest.requires.filter((feature) => !HOST_FEATURES.has(feature));
}

async function loadPlugin(pluginId: string): Promise<PluginDefinition | null> {
  const registered = registry.get(pluginId);
  if (!registered) return null;

  const missing = unsupportedRequirements(registered.manifest);
  if (missing.length) {
    console.warn(
      `[plugins] ${pluginId} requires host features this build lacks: ${missing.join(", ")}`
    );
    return null;
  }

  if (registered.loaded && registered.definition) {
    return registered.definition;
  }

  // Check if we're already loading this plugin
  if (loadPromises.has(pluginId)) {
    return loadPromises.get(pluginId)!;
  }

  const loadPromise = (async () => {
    try {
      const path = `../../../plugins/${pluginId}/index.ts`;
      const loader = pluginGlob[path];
      if (!loader) {
        console.error(`[plugins] no plugin code found for ${pluginId}`);
        return null;
      }

      const mod = await loader();
      const definition = mod.default;

      if (!definition) {
        console.error(`[plugins] ${pluginId} export is not a plugin definition`);
        return null;
      }

      registered.definition = definition;
      registered.loaded = true;
      return definition;
    } catch (err) {
      console.error(`[plugins] failed to load plugin ${pluginId}:`, err);
      return null;
    } finally {
      loadPromises.delete(pluginId);
    }
  })();

  loadPromises.set(pluginId, loadPromise);
  return loadPromise;
}

export function getRegistry(): ReadonlyMap<string, RegisteredPlugin> {
  return registry;
}

export async function getPlugin(
  pluginId: string
): Promise<PluginDefinition | null> {
  return loadPlugin(pluginId);
}

export function isPluginEnabled(
  pluginId: string,
  disabledIds: string[]
): boolean {
  const registered = registry.get(pluginId);
  if (!registered) return false;
  return !disabledIds.includes(pluginId);
}

export function getManifest(pluginId: string): PluginManifest | null {
  const registered = registry.get(pluginId);
  return registered?.manifest ?? null;
}

// Initialize on module load
if (typeof window !== "undefined") {
  initializeRegistry();
}
