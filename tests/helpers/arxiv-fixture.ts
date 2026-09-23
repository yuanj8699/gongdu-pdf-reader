/** Offline arXiv boundary fixture: responses vary, but parsing, jobs, storage and PDF validation stay real. */
export function atomFeed(ids: string[], title = "Test &amp; paper") {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
    <opensearch:totalResults>${ids.length}</opensearch:totalResults>${ids.map(id => `<entry>
    <id>http://arxiv.org/abs/${id}</id><title>${title}</title><summary>A paper with &lt;script&gt;plain text&lt;/script&gt;.</summary>
    <author><name>Researcher A</name></author><author><name>Researcher B</name></author>
    <published>2020-01-01T00:00:00Z</published><updated>2020-02-01T00:00:00Z</updated>
    <link title="pdf" href="http://arxiv.org/pdf/${id}" /></entry>`).join("")}</feed>`;
}
