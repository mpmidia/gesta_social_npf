module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'development'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
