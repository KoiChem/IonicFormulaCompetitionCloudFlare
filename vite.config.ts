import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import deployment from './src/config/deployment-public.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  const base = mode === 'cloudflare' ? '/' : '/IonicFormulaCompetition/';

  return {
    base,
    plugins: [react()],
    build: { sourcemap: false },
    define: {
      'import.meta.env.VITE_SUPABASE_FUNCTION_REGION': JSON.stringify(
        env.VITE_SUPABASE_FUNCTION_REGION || deployment.functionRegion,
      ),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
        env.VITE_SUPABASE_URL || deployment.url,
      ),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(
        env.VITE_SUPABASE_PUBLISHABLE_KEY || deployment.publishableKey,
      ),
    },
  };
});
