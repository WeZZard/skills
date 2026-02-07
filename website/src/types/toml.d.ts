declare module "toml" {
  export function parse(input: string): Record<string, unknown>;
}
