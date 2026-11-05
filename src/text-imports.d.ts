/** Files built into the binary as text: `import source from "./x.py" with { type: "text" }`. */
declare module "*.py" {
  const source: string;
  export default source;
}
