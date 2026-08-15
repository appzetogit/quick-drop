import { useEffect, useRef } from "react"

/**
 * Rewrites the food vocabulary into quick-commerce vocabulary for every screen
 * under it: Food -> Product, Restaurant -> Seller.
 *
 * The QC panel deliberately reuses the food admin screens (see AdminRouter), which
 * means their copy -- card titles, table headers, buttons, empty states -- says
 * "Food" and "Restaurant" in a vertical that sells groceries through sellers.
 * Editing the strings per screen is not an option while the screens are shared:
 * dozens of files, and every future food screen would reintroduce the words.
 *
 * So the swap happens at the text-node layer, once, for the whole subtree. A
 * MutationObserver keeps it applied as React re-renders. The observer disconnects
 * while it edits so its own mutations never re-trigger it.
 *
 * What this deliberately does NOT touch: input values, placeholders and attributes
 * (not text nodes), and anything outside the QC route subtree. Data text (order ids,
 * names) passes through the same filter -- a seller literally named "Restaurant X"
 * would display as "Seller X". Acceptable for this vertical's data.
 */
const RULES = [
  [/\bFoods\b/g, "Products"],
  [/\bFood\b/g, "Product"],
  [/\bfoods\b/g, "products"],
  [/\bfood\b/g, "product"],
  [/\bRestaurants\b/g, "Sellers"],
  [/\bRestaurant\b/g, "Seller"],
  [/\brestaurants\b/g, "sellers"],
  [/\brestaurant\b/g, "seller"],
]

const rewrite = (text) => RULES.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text)

const rewriteTextNodes = (root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const next = rewrite(node.nodeValue)
    if (next !== node.nodeValue) node.nodeValue = next
  }
}

export default function VerticalVocabulary({ children }) {
  const ref = useRef(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return undefined

    let observer
    const apply = () => {
      observer.disconnect()
      rewriteTextNodes(root)
      observer.observe(root, { childList: true, characterData: true, subtree: true })
    }
    observer = new MutationObserver(apply)
    observer.observe(root, { childList: true, characterData: true, subtree: true })
    rewriteTextNodes(root)

    return () => observer.disconnect()
  }, [])

  // display:contents keeps this wrapper out of the layout entirely.
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  )
}
