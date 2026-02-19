// ---------------------------------------------------------------------------
// OpsPilot — Dependency Resolver
// ---------------------------------------------------------------------------
// Performs topological sort on module dependency graphs to determine safe
// startup order. Detects and rejects circular dependencies.
// ---------------------------------------------------------------------------

import { ModuleManifest } from '../types/module';
import { DependencyError } from '../../shared/errors';

export interface DependencyGraph {
  /** Module IDs in safe startup order (dependencies before dependents). */
  order: string[];

  /** Adjacency list: moduleId → IDs it depends on. */
  edges: Map<string, string[]>;
}

export class DependencyResolver {
  /**
   * Compute startup order from a set of module manifests.
   *
   * @param manifests  All manifests that will participate in this lifecycle.
   * @returns Topologically sorted module IDs.
   * @throws DependencyError on missing dependencies or cycles.
   */
  resolve(manifests: ModuleManifest[]): DependencyGraph {
    const ids = new Set(manifests.map((m) => m.id));
    const edges = new Map<string, string[]>();

    // Build adjacency list and validate that all deps exist
    for (const manifest of manifests) {
      const deps = manifest.dependencies ?? [];
      for (const dep of deps) {
        if (!ids.has(dep)) {
          throw new DependencyError(
            `Module "${manifest.id}" depends on "${dep}", which is not registered or not enabled.`,
          );
        }
        if (dep === manifest.id) {
          throw new DependencyError(
            `Module "${manifest.id}" lists itself as a dependency.`,
          );
        }
      }
      edges.set(manifest.id, [...deps]);
    }

    // Kahn's algorithm for topological sort + cycle detection
    const inDegree = new Map<string, number>();
    for (const id of ids) {
      inDegree.set(id, 0);
    }
    for (const [, deps] of edges) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
      }
    }

    // Wait — inDegree should count how many modules depend ON this module,
    // but for topological sort we actually need to count incoming edges
    // from the perspective of "who must start first".
    //
    // Correction: edges maps moduleId → its dependencies.
    // So if A depends on B, edge is A→B, meaning B must start first.
    // In topo sort B should come before A.
    // In-degree(A) = number of modules that A depends on? No —
    // In Kahn's, in-degree = number of incoming edges in the DAG.
    // If A→B means "A depends on B", then the topo order is B, A.
    // In the DAG, the edge direction for topo sort should be B→A
    // (B must come before A). So incoming edges to A = its dependencies.

    // Recompute: in-degree of X = number of dependencies X has
    for (const id of ids) {
      inDegree.set(id, edges.get(id)?.length ?? 0);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order: string[] = [];

    while (queue.length > 0) {
      // Sort queue for deterministic order among modules with same in-degree
      queue.sort();
      const current = queue.shift()!;
      order.push(current);

      // For each module that depends on `current`, decrease its in-degree
      for (const [id, deps] of edges) {
        if (deps.includes(current)) {
          const newDeg = (inDegree.get(id) ?? 1) - 1;
          inDegree.set(id, newDeg);
          if (newDeg === 0) {
            queue.push(id);
          }
        }
      }
    }

    if (order.length !== ids.size) {
      const remaining = [...ids].filter((id) => !order.includes(id));
      throw new DependencyError(
        `Circular dependency detected involving modules: ${remaining.join(', ')}`,
      );
    }

    return { order, edges };
  }
}
