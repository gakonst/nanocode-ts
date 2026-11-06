export type Comment = {
  note: string
  rect: Rect
  selector: string
  tag: string
  text: string
}

export type Rect = { height: number; width: number; x: number; y: number }

export type Report = {
  comments: readonly Comment[]
  title: string
  url: string
  viewport: { height: number; width: number }
}

export function describe(element: Element, options: describe.Options): Comment {
  const box = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView

  return {
    note: options.note,
    rect: {
      height: Math.round(box.height),
      width: Math.round(box.width),
      x: Math.round(box.left + (view?.scrollX ?? 0)),
      y: Math.round(box.top + (view?.scrollY ?? 0)),
    },
    selector: selector(element),
    tag: element.tagName.toLowerCase(),
    text: excerpt(element, options.excerpt),
  }
}

export declare namespace describe {
  type Options = { excerpt: number; note: string }
}

export function prompt(report: Report): string {
  const page = report.title ? `"${report.title}" (${report.url})` : report.url

  return [
    `Feedback on ${page}, seen in a ${report.viewport.width}×${report.viewport.height} viewport:`,
    '',
    ...report.comments.map((comment, index) =>
      [
        `${index + 1}. ${comment.note}`,
        `   On <${comment.tag}> at ${comment.selector}${comment.text ? `: "${comment.text}"` : ''}`,
      ].join('\n'),
    ),
  ].join('\n')
}

export function selector(element: Element): string {
  const parts: string[] = []

  for (
    let node: Element | null = element;
    node && node.tagName !== 'HTML';
    node = node.parentElement
  ) {
    if (node.id && node.ownerDocument.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift('#' + CSS.escape(node.id))
      break
    }

    const tag = node.tagName.toLowerCase()
    const current = node
    const same = Array.from(node.parentElement?.children ?? []).filter(
      (sibling) => sibling.tagName === current.tagName,
    )
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag)
  }

  return parts.join(' > ')
}

function excerpt(element: Element, characters: number) {
  const text = ((element as HTMLElement).innerText ?? element.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const named =
    text ||
    element.getAttribute('aria-label') ||
    element.getAttribute('alt') ||
    element.getAttribute('title') ||
    ''

  return named.length > characters ? named.slice(0, characters) + '…' : named
}
