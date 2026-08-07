// Makes the generated Worker environment types available to `cloudflare:workers`.
declare module 'cloudflare:workers' {
	interface ProvidedEnv extends Env {}
}
