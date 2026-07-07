export function baseLayout(opts: { title: string; bodyContent: string; extraHead?: string; bodyScripts?: string }): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title} · NFP Gestão</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="/static/styles.css" rel="stylesheet">
  ${opts.extraHead ?? ''}
</head>
<body class="bg-gray-50 min-h-screen">
  ${opts.bodyContent}
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
  ${opts.bodyScripts ?? ''}
</body>
</html>`
}
