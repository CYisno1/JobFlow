import { jsPDF } from 'jspdf'

// ── Parse the AI-generated plain-text resume ─────────────────
interface ResumeSection {
  type: 'name' | 'contact' | 'header' | 'subheader' | 'bullet' | 'text' | 'blank'
  content: string
}

function parseResumeText(text: string): ResumeSection[] {
  const lines = text.split('\n')
  const sections: ResumeSection[] = []
  let headerFound = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) { sections.push({ type: 'blank', content: '' }); continue }

    // First non-empty line = name
    if (!headerFound && i < 3 && !trimmed.startsWith('-') && !trimmed.startsWith('•')) {
      // Looks like a name (no colon, no | separators)
      if (!trimmed.includes('|') && !trimmed.includes(':') && !trimmed.includes('@')) {
        sections.push({ type: 'name', content: trimmed })
        headerFound = true
        continue
      }
    }

    // Contact line (email/phone/linkedin)
    if (trimmed.includes('@') || trimmed.includes('|') || /\(\d{3}\)/.test(trimmed) || trimmed.includes('linkedin')) {
      sections.push({ type: 'contact', content: trimmed })
      continue
    }

    // Section header (ALL CAPS, or followed by ---- / ====)
    const nextLine = lines[i + 1]?.trim() ?? ''
    const isHeader = (
      (trimmed === trimmed.toUpperCase() && trimmed.length > 2 && !/^\d/.test(trimmed) && !trimmed.startsWith('-')) ||
      nextLine.startsWith('---') || nextLine.startsWith('===')
    )
    if (isHeader && !trimmed.startsWith('-') && !trimmed.startsWith('•')) {
      sections.push({ type: 'header', content: trimmed })
      if (nextLine.startsWith('---') || nextLine.startsWith('===')) i++ // skip separator line
      continue
    }

    // Bullet point
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      sections.push({ type: 'bullet', content: trimmed.replace(/^[-•*]\s+/, '') })
      continue
    }

    // Sub-header (bold-looking: not a bullet, short, no long trailing text)
    if (trimmed.length < 80 && !trimmed.endsWith('.') && trimmed.split(' ').length < 8) {
      sections.push({ type: 'subheader', content: trimmed })
      continue
    }

    sections.push({ type: 'text', content: trimmed })
  }

  return sections
}

// ── Generate the PDF ─────────────────────────────────────────
export function generateResumePdf(resumeText: string): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 50
  const contentW = pageW - margin * 2
  let y = 45

  const sections = parseResumeText(resumeText)

  function addPage() {
    doc.addPage()
    y = 45
  }

  function checkPageBreak(needed: number) {
    if (y + needed > doc.internal.pageSize.getHeight() - 40) addPage()
  }

  for (const section of sections) {
    switch (section.type) {
      case 'name':
        checkPageBreak(24)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(18)
        doc.text(section.content, pageW / 2, y, { align: 'center' })
        y += 22
        break

      case 'contact':
        checkPageBreak(14)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.setTextColor(80, 80, 80)
        doc.text(section.content, pageW / 2, y, { align: 'center' })
        doc.setTextColor(0, 0, 0)
        y += 14
        break

      case 'header':
        checkPageBreak(22)
        y += 6
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(11)
        doc.text(section.content, margin, y)
        y += 3
        doc.setDrawColor(0, 0, 0)
        doc.setLineWidth(0.8)
        doc.line(margin, y, margin + contentW, y)
        y += 9
        break

      case 'subheader': {
        checkPageBreak(14)
        // Split left text from right-aligned date (format: company ... date)
        const dateMatch = section.content.match(/^(.*?)\s{2,}(\w.*\d{4}.*)$/) ||
                          section.content.match(/^(.*?)\t(.+)$/)
        if (dateMatch) {
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(10)
          doc.text(dateMatch[1].trim(), margin, y)
          doc.setFont('helvetica', 'normal')
          doc.text(dateMatch[2].trim(), margin + contentW, y, { align: 'right' })
        } else {
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(10)
          doc.text(section.content, margin, y)
        }
        y += 13
        break
      }

      case 'bullet': {
        checkPageBreak(12)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        const bulletLines = doc.splitTextToSize(section.content, contentW - 14)
        doc.text('•', margin + 4, y)
        doc.text(bulletLines, margin + 14, y)
        y += bulletLines.length * 11
        break
      }

      case 'text': {
        checkPageBreak(12)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        const wrapped = doc.splitTextToSize(section.content, contentW)
        doc.text(wrapped, margin, y)
        y += wrapped.length * 11
        break
      }

      case 'blank':
        y += 4
        break
    }
  }

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer)
}
