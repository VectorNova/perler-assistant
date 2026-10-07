import { build } from 'esbuild'
const { outputFiles } = await build({
  entryPoints: ['tools/verify-quantization-entry.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false, logLevel: 'warning',
})
try {
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
