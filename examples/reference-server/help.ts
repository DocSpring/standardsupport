// A stand-in for "answer from our own documentation". It matches words in the question against three made-up help
// articles. In a real product this is your docs search, or an agent of yours that can read your docs and nothing else.
//
// That last part is what makes it safe to automate: whatever answers here sees only the question and public
// documentation. It has no account data, no credentials and no tools, so a question written to trick it has nothing
// to reach.

const ARTICLES = [
  {
    title: 'Order numbers',
    url: 'https://docs.example.com/orders/numbers',
    words: ['order', 'number', 'loaded', 'not found', 'lookup_order'],
    text:
      'Order numbers are four digits and start at 1000. "Order could not be loaded" for a number below 1000 means ' +
      'the number does not exist: check it with the customer. For a number of 1000 or above, the same error is a ' +
      'problem on our side and worth reporting.',
  },
  {
    title: 'Order statuses',
    url: 'https://docs.example.com/orders/statuses',
    words: ['status', 'shipped', 'pending', 'delivered', 'cancelled'],
    text: 'An order is pending, shipped, delivered or cancelled. "Shipped" means it has left the warehouse.',
  },
  {
    title: 'Rate limits',
    url: 'https://docs.example.com/api/rate-limits',
    words: ['rate', 'limit', '429', 'too many', 'throttle'],
    text: 'Each account may look up 100 orders a minute. A 429 response says when to try again.',
  },
]

export interface HelpQuestion {
  question: string
  tool?: string
  error?: string
}

export interface HelpAnswer {
  answer: string
  sources?: { title: string; url: string }[]
}

// Answers a question from documentation, or returns undefined when the documentation has nothing on it.
export type Help = (question: HelpQuestion) => Promise<HelpAnswer | undefined>

export const answerFromDocs: Help = async ({ question, tool, error }) => {
  const asked = [question, tool, error].filter(Boolean).join(' ').toLowerCase()
  const matches = ARTICLES.map((article) => ({
    article,
    score: article.words.filter((word) => asked.includes(word)).length,
  }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
  if (matches.length === 0) return undefined
  return {
    answer: matches.map((match) => match.article.text).join('\n\n'),
    sources: matches.map((match) => ({ title: match.article.title, url: match.article.url })),
  }
}
