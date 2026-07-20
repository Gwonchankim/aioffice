import { defineConfig } from 'vite';

function validatedApiOrigin(value: string | undefined): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value ?? '');
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);

  if (!match || port > 65535) {
    throw new Error('ORION_API_ORIGIN must be http://127.0.0.1:<port>.');
  }

  return match.input;
}

export default defineConfig(({ command }) => {
  if (command !== 'serve') {
    return {};
  }

  return {
    server: {
      proxy: {
        '/api': {
          target: validatedApiOrigin(process.env.ORION_API_ORIGIN),
          changeOrigin: true,
        },
      },
    },
  };
});
