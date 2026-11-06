// Synthetic fixtures shaped like each feed's documented schema (see the
// comments in src/feeds/*.ts). CVE-2099-* identifiers are deliberately fictional.

export const KEV_FIXTURE = {
  title: 'CISA Catalog of Known Exploited Vulnerabilities',
  catalogVersion: '2099.01.15',
  dateReleased: '2099-01-15T17:00:00.000Z',
  count: 3,
  vulnerabilities: [
    {
      cveID: 'CVE-2099-0001',
      vendorProject: 'Example Corp',
      product: 'Gateway',
      vulnerabilityName: 'Example Corp Gateway Command Injection Vulnerability',
      dateAdded: '2099-01-14',
      shortDescription: 'Example Corp Gateway contains a command injection vulnerability.',
      requiredAction: 'Apply mitigations per vendor instructions or discontinue use.',
      dueDate: '2099-02-04',
      knownRansomwareCampaignUse: 'Known',
      notes: 'https://example.com/advisory/1 ; https://nvd.nist.gov/vuln/detail/CVE-2099-0001',
      cwes: ['CWE-78'],
    },
    {
      cveID: 'CVE-2099-0002',
      vendorProject: 'Sample Inc',
      product: 'Viewer',
      vulnerabilityName: 'Sample Viewer Use-After-Free',
      dateAdded: '2099-01-02',
      shortDescription: 'Use-after-free.\u0000 Injected control char.',
      requiredAction: 'Update.',
      dueDate: '2099-01-23',
      knownRansomwareCampaignUse: 'Unknown',
      notes: '',
      cwes: [],
    },
    { cveID: 'not-a-cve', dateAdded: '2099-01-01' },
  ],
};

export const NVD_FIXTURE = {
  resultsPerPage: 1,
  startIndex: 0,
  totalResults: 1,
  format: 'NVD_CVE',
  version: '2.0',
  vulnerabilities: [
    {
      cve: {
        id: 'CVE-2099-0001',
        published: '2099-01-10T15:15:08.000',
        lastModified: '2099-01-14T20:00:00.123',
        vulnStatus: 'Analyzed',
        descriptions: [
          { lang: 'es', value: 'Descripción.' },
          {
            lang: 'en',
            value: 'A command injection flaw allows remote code execution. More detail here.',
          },
        ],
        metrics: {
          cvssMetricV31: [
            {
              source: 'nvd@nist.gov',
              type: 'Primary',
              cvssData: {
                version: '3.1',
                vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                baseScore: 9.8,
                baseSeverity: 'CRITICAL',
              },
            },
          ],
        },
        weaknesses: [
          {
            source: 'nvd@nist.gov',
            type: 'Primary',
            description: [{ lang: 'en', value: 'CWE-78' }],
          },
        ],
        references: [
          { url: 'https://example.com/advisory/1', source: 'x' },
          { url: 'http://insecure.example/ref', source: 'x' },
        ],
      },
    },
  ],
};

export const OSV_FIXTURE = {
  vulns: [
    {
      id: 'GHSA-xxxx-yyyy-zzzz',
      summary: 'Prototype pollution in example-lib',
      details: 'example-lib before 4.17.21 allows prototype pollution.',
      aliases: ['CVE-2099-0003', 'GHSA-xxxx-yyyy-zzzz'],
      modified: '2099-01-12T00:00:00Z',
      published: '2099-01-05T00:00:00Z',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N' }],
      affected: [
        {
          package: { ecosystem: 'npm', name: 'example-lib', purl: 'pkg:npm/example-lib' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
        },
      ],
      references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }],
      database_specific: { severity: 'MODERATE', cwe_ids: ['CWE-1321'] },
    },
    { id: 'PYSEC-2099-1', summary: '', details: 'Older issue', modified: '2099-01-01T00:00:00Z' },
  ],
  next_page_token: 'abc',
};
