import { createClient, type SanityClient } from "@sanity/client";
import { env, getSanityProjectConfig, sanityProjects } from "./env";

// ─── Default Client (backward compatible) ──────────────────────
// This is the legacy singleton client that existing code imports.
// It connects to the primary Sanity project.

export const sanityClient = createClient({
  projectId: env.sanityProjectId,
  dataset: env.sanityDataset,
  apiVersion: env.sanityApiVersion,
  useCdn: false,
  token: env.sanityApiToken || undefined,
  perspective: env.sanityApiToken ? "drafts" : "published",
});

// ─── Multi-Database Client Factory ─────────────────────────────

const clientCache = new Map<string, SanityClient>();

/**
 * Get (or create) a Sanity client for a specific database key.
 * Clients are cached and reused for the process lifetime.
 *
 * Supports both role-based keys (e.g. "inventory", "billing")
 * and legacy numbered keys (e.g. "project-2").
 *
 * @example
 * ```ts
 * const client = getProjectSanityClient("inventory");
 * const docs = await client.fetch(`*[_type == "product"]`);
 * ```
 */
export function getProjectSanityClient(projectKey: string): SanityClient {
  const cached = clientCache.get(projectKey);
  if (cached) return cached;

  const config = getSanityProjectConfig(projectKey);
  if (!config) {
    throw new Error(
      `Unknown Sanity database: "${projectKey}". Available: ${sanityProjects.map((p) => p.id).join(", ")}`
    );
  }
  if (!config.enabled) {
    throw new Error(`Sanity database "${projectKey}" is disabled.`);
  }

  const client = createClient({
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    useCdn: false,
    token: config.token || undefined,
    perspective: config.token ? "drafts" : "published",
  });

  clientCache.set(projectKey, client);
  return client;
}

/**
 * Get a read-only (CDN) client for a specific database.
 */
export function getReadOnlySanityClient(projectKey: string): SanityClient {
  const cacheKey = `${projectKey}:readonly`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const config = getSanityProjectConfig(projectKey);
  if (!config) {
    throw new Error(`Unknown Sanity database: "${projectKey}"`);
  }

  const client = createClient({
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    useCdn: true,
    perspective: "published",
  });

  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Get all enabled database keys.
 */
export function getEnabledProjectKeys(): string[] {
  return sanityProjects.filter((p) => p.enabled).map((p) => p.id);
}

/**
 * Get database keys by role.
 */
export function getProjectKeysByRole(role: string): string[] {
  return sanityProjects
    .filter((p) => p.enabled && p.role === role)
    .map((p) => p.id);
}

/**
 * Clear cached clients (for testing or token rotation).
 */
export function evictProjectClient(projectKey?: string): void {
  if (projectKey) {
    clientCache.delete(projectKey);
    clientCache.delete(`${projectKey}:readonly`);
  } else {
    clientCache.clear();
  }
}
