import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["main.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{ ignores: ["node_modules/**", "main.js", "esbuild.config.mjs"] },
];
