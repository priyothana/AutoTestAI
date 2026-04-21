/**
 * Recursive Character Text Splitter
 *
 * A lightweight utility to split text into chunks for embeddings, prioritizing
 * logical breaks (paragraphs, newlines, sentences) with overlapping context.
 */

export interface TextSplitterOptions {
  chunkSize: number
  chunkOverlap: number
  separators?: string[]
}

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', '']

export class RecursiveCharacterTextSplitter {
  private chunkSize: number
  private chunkOverlap: number
  private separators: string[]

  constructor(options: TextSplitterOptions) {
    this.chunkSize = options.chunkSize
    this.chunkOverlap = options.chunkOverlap
    this.separators = options.separators ?? DEFAULT_SEPARATORS
  }

  public splitText(text: string): string[] {
    const finalList: string[] = []
    let separator = this.separators[this.separators.length - 1]
    let newSeparators = []

    for (let i = 0; i < this.separators.length; i++) {
      const s = this.separators[i]
      if (s === '') {
        separator = s
        break
      }
      if (text.includes(s)) {
        separator = s
        newSeparators = this.separators.slice(i + 1)
        break
      }
    }

    const splits = this.splitOnSeparator(text, separator)
    let goodSplits: string[] = []

    const mergeSplits = () => {
      const merged = this.mergeSplits(goodSplits, separator)
      finalList.push(...merged)
      goodSplits = []
    }

    for (const split of splits) {
      if (split.length < this.chunkSize) {
        goodSplits.push(split)
      } else {
        if (goodSplits.length > 0) mergeSplits()
        if (newSeparators.length > 0) {
          const otherInfo = new RecursiveCharacterTextSplitter({
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap,
            separators: newSeparators,
          }).splitText(split)
          finalList.push(...otherInfo)
        } else {
          // Fallback to strict length split
          let start = 0
          while (start < split.length) {
            finalList.push(split.substring(start, start + this.chunkSize))
            start += this.chunkSize - this.chunkOverlap
          }
        }
      }
    }
    if (goodSplits.length > 0) Object.assign(finalList, [...finalList, ...this.mergeSplits(goodSplits, separator)])

    return finalList
  }

  private splitOnSeparator(text: string, separator: string): string[] {
    if (separator === '') return text.split('')
    return text.split(separator)
  }

  private mergeSplits(splits: string[], separator: string): string[] {
    const docs: string[] = []
    let currentDoc: string[] = []
    let total = 0

    for (const split of splits) {
      const sepLen = currentDoc.length > 0 ? separator.length : 0
      if (total + split.length + sepLen > this.chunkSize && currentDoc.length > 0) {
        docs.push(currentDoc.join(separator))
        
        // Handle overlap
        while (currentDoc.length > 0 && total > this.chunkOverlap) {
          const removed = currentDoc.shift()!
          total -= removed.length + (currentDoc.length > 0 ? separator.length : 0)
        }
      }
      currentDoc.push(split)
      total += split.length + (currentDoc.length > 1 ? separator.length : 0)
    }

    if (currentDoc.length > 0) {
      docs.push(currentDoc.join(separator))
    }

    return docs
  }
}
