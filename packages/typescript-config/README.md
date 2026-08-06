# @repo/typescript-config

Shared `tsconfig` bases.

| Config         | Use for                                                    |
| -------------- | ---------------------------------------------------------- |
| `base.json`    | Everything — strict compiler options, ES2023, NodeNext      |
| `node.json`    | Node applications (`base` + `types: ["node"]`)              |
| `library.json` | Internal libraries consumed by other workspaces (`composite`) |

## Usage

These bases deliberately contain **no path options**. TypeScript resolves
relative paths against the file they are written in, so `include`, `outDir`,
and `rootDir` in a shared base would point back at this package. Declare them
in the consuming workspace instead:

```json
{
  "extends": "@repo/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Add `"@repo/typescript-config": "workspace:*"` to the workspace's
`devDependencies`.
