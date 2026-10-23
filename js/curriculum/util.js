// Compact graph builder for lesson definitions.
// Node tuple: [id, type, x, y, params?, label?]; edge: 'from>to'.
export function G(nodes, edges) {
  return {
    nodes: nodes.map(([id, type, x, y, params, label]) => ({ id, type, x, y, params: params || {}, label: label || '' })),
    edges: edges.map(s => {
      const [from, to] = s.split('>');
      return { id: `e_${from}_${to}`, from, to };
    }),
  };
}

// Column / row helpers so layouts stay tidy.
export const X = i => i * 250;
export const Y = i => i * 140;
