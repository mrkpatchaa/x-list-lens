import { buildExportFile, downloadBlob, type ExportFormat } from './export-download'

const status = document.getElementById('exportStatus') as HTMLParagraphElement
const format: ExportFormat = new URLSearchParams(location.search).get('format') === 'json' ? 'json' : 'csv'

buildExportFile(format)
    .then(({ name, blob }) => {
        const link = downloadBlob(name, blob)
        link.className = 'font-semibold text-blue-300 underline'
        status.textContent = 'If the download did not start, click this link: '
        status.appendChild(link)
    })
    .catch(() => {
        status.textContent = 'ListLens could not build the export. Close this tab and try again.'
    })
