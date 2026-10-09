import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react(),{name:'lite-release',transformIndexHtml(html){return html.replace('</head>',`<meta name="lite-release" content="${process.env.VITE_LITE_RELEASE??'development'}"/></head>`);}}], build: { sourcemap: false } });
