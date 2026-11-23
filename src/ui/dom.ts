/**
 * Building the panel. Text always goes in as text (never as HTML) and listeners are added in
 * code, so the page's Content Security Policy needs no inline scripts.
 */

type Props = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = String(value);
    else if (name === 'text') element.textContent = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Replaces what an element shows. */
export function show(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** A link that opens on Converter Studio's site, in a new tab. */
export function externalLink(href: string, text: string, className = 'link'): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: className, text });
}

/** A labelled `<select>` with its options. */
export function select<T extends string>(
  id: string,
  label: string,
  options: ReadonlyArray<readonly [T, string]>,
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  const element = h('select', { id, class: 'select' });
  for (const [optionValue, text] of options) {
    const option = h('option', { value: optionValue, text });
    if (optionValue === value) option.selected = true;
    element.appendChild(option);
  }
  element.addEventListener('change', () => onChange(element.value as T));
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, class: 'label', text: label }),
    element,
  );
}
