import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			leaflet: fileURLToPath(new URL('./src/Leaflet.js', import.meta.url)),
		},
	},
	test: {
		include: ['benchmarks/**/*.bench.js'],
	},
});
