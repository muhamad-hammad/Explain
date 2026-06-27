// Builds 'contains' edges from parent/child GraphNode relationships.

import { GraphEdge, GraphNode } from '../shared/types';

export class EdgeBuilder {
  /** One 'contains' edge per node that has a parent. */
  buildContains(nodes: GraphNode[]): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const node of nodes) {
      if (!node.parentId) {
        continue;
      }
      edges.push({
        id: `contains::${node.parentId}::${node.id}`,
        type: 'contains',
        sourceId: node.parentId,
        targetId: node.id,
      });
    }
    return edges;
  }
}
