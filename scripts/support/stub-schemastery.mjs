/** Minimal chainable schema stub so plugin wiring can be exercised outside DSH. */
const chain = new Proxy(function () {}, {
  get: (_target, property) => (property === 'default' ? () => chain : () => chain),
  apply: () => chain,
})
export default new Proxy({}, { get: () => chain })
