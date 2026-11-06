/**
 * Providers as ENS reports them: name, resolver, payee, price, capabilities,
 * and the block they were read at. Below them, two committed deployment
 * records (D-066): the agents' ERC-8004 identities and the ENSv2 name setups.
 * Those come from files written by verified scripts, not from a run, and are
 * labelled so; the firewall never reads them.
 */
import { useApp } from '../App.tsx';
import { Empty, ErrorNotice, Hbar, Loading, PageHead, Proof, Status } from '../components/ui.tsx';
import { useApi } from '../hooks.tsx';
import {
  etherscanAddress,
  etherscanBlock,
  etherscanToken,
  hashscanAccount,
  safeHref,
} from '../lib/explorers.ts';
import { utcTime } from '../lib/format.ts';
import type { EnsSetupKind, EnsSetups, Erc8004Identity, ProvidersResponse } from '../lib/types.ts';

const SETUP_TEXT: Readonly<Record<EnsSetupKind, { title: string; what: string }>> = {
  expiring: {
    title: 'Expiring listing',
    what: 'Registered with a short expiry. Once it passes, ENS reports the name as available and discovery skips it.',
  },
  transferable: {
    title: 'Transferable name',
    what: 'Registered with the transfer right, then moved to another owner.',
  },
  locked: {
    title: 'Non-transferable name',
    what: 'Registered without the transfer right: a transfer reverts (TransferDisallowed).',
  },
  wildcard: {
    title: 'Wildcard default',
    what: 'A name with no record of its own resolves to the parent resolver’s default record.',
  },
  alias: {
    title: 'Alias',
    what: 'A second name linked to the parent’s record set (linkToNode).',
  },
};

function IdentityRecord({ identity }: { identity: Erc8004Identity | null | undefined }) {
  if (identity === undefined) return null;
  return (
    <section className="record" aria-labelledby="identity-title">
      <div className="section-head">
        <h2 id="identity-title">ERC-8004 agent identities</h2>
        <span className="source">From the committed deployment record</span>
      </div>
      {identity === null || Object.keys(identity.agents).length === 0 ? (
        <p className="hint">
          Not registered yet. The owner registers the agents on the Sepolia ERC-8004 Identity
          Registry with <code>pnpm erc8004:register</code>; this lists them after the next deploy.
        </p>
      ) : (
        <>
          <p className="hint">
            Identity and discovery only: prices and payees still come from ENS, and no trust model
            is claimed. Registry{' '}
            <Proof
              value={identity.identityRegistry}
              href={etherscanAddress(identity.identityRegistry)}
              label="ERC-8004 Identity Registry"
            />
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Agent ID</th>
                  <th scope="col">Registration file</th>
                  <th scope="col">Owner</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(identity.agents).map(([label, a]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>
                      <Proof
                        value={a.agentId}
                        href={etherscanToken(identity.identityRegistry, a.agentId)}
                        label="ERC-8004 agent ID"
                        full
                      />
                    </td>
                    <td>
                      {safeHref(a.agentURI) === null ? (
                        <code className="wrap">{a.agentURI}</code>
                      ) : (
                        <a href={a.agentURI} target="_blank" rel="noreferrer noopener">
                          {label}.json
                        </a>
                      )}
                    </td>
                    <td>
                      <Proof value={a.owner} href={etherscanAddress(a.owner)} label="owner" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SetupsRecord({ record }: { record: EnsSetups | null | undefined }) {
  if (record === undefined) return null;
  return (
    <section className="record" aria-labelledby="setups-title">
      <div className="section-head">
        <h2 id="setups-title">ENSv2 name setups</h2>
        <span className="source">From the committed deployment record</span>
      </div>
      {record === null || record.setups.length === 0 ? (
        <p className="hint">
          Not set up yet. The owner proves them on Sepolia with <code>pnpm ens:setups</code>; this
          lists them after the next deploy.
        </p>
      ) : (
        <ul className="setup-list">
          {record.setups.map((x) => {
            const expiry = x.expiry === null ? null : Number(x.expiry) * 1000;
            const lapsed = expiry !== null && expiry < Date.now();
            return (
              <li key={`${x.kind}-${x.name}`}>
                <div className="setup-head">
                  <strong>{SETUP_TEXT[x.kind].title}</strong>
                  <code className="wrap">{x.name}</code>
                  {x.kind === 'expiring' && expiry !== null ? (
                    <Status tone={lapsed ? 'neutral' : 'warn'}>
                      {lapsed ? 'Expired' : 'Expires'} {utcTime(new Date(expiry).toISOString())}
                    </Status>
                  ) : null}
                </div>
                <p className="hint">{SETUP_TEXT[x.kind].what}</p>
                <p className="setup-proof">Verified: {x.proof}</p>
                {x.owner === null ? null : (
                  <p className="hint">
                    Owner <Proof value={x.owner} href={etherscanAddress(x.owner)} label="owner" />
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProvidersPage() {
  const { config } = useApp();
  const res = useApi<ProvidersResponse>('/api/providers');

  return (
    <>
      <PageHead
        title="Providers"
        intro={`Data providers listed under ${config.ensParent} on ENS, read from the chain on every task.`}
      />
      {res.error !== null ? (
        <ErrorNotice error={res.error} />
      ) : res.data === null ? (
        <Loading what="providers" />
      ) : res.data.snapshot === null || res.data.providers.length === 0 ? (
        <Empty title="No providers discovered yet.">
          <p>
            The agent discovers providers on ENS when a task starts.{' '}
            <a href="#/new">Start a task</a> to read them.
          </p>
        </Empty>
      ) : (
        <>
          <p className="proof-banner">
            Read from ENS at Sepolia block{' '}
            <Proof
              value={res.data.snapshot.blockNumber ?? '?'}
              href={etherscanBlock(res.data.snapshot.blockNumber ?? '')}
              label="Sepolia block"
              full
            />{' '}
            on {utcTime(res.data.snapshot.observedAt)}, during{' '}
            <a href={`#/tasks/${res.data.snapshot.runId}`}>this task</a>.
          </p>
          <ul className="provider-list">
            {res.data.providers.map((p) => (
              <li key={p.ensName} className="provider">
                <h2>{p.ensName}</h2>
                <dl>
                  <dt>Resolver</dt>
                  <dd>
                    <Proof
                      value={p.resolver}
                      href={etherscanAddress(p.resolver)}
                      label="resolver address"
                    />
                  </dd>
                  <dt>Paid to</dt>
                  <dd>
                    <Proof
                      value={p.payTo}
                      href={hashscanAccount(config.networks.hedera, p.payTo)}
                      label="Hedera payee account"
                      full
                    />
                  </dd>
                  <dt>Price</dt>
                  <dd>
                    <Hbar tinybars={p.priceAtomic} /> per request
                  </dd>
                  <dt>Sells</dt>
                  <dd>
                    <ul className="chips">
                      {p.capabilities.map((c) => (
                        <li key={c}>{c.replace(/-/g, ' ')}</li>
                      ))}
                    </ul>
                  </dd>
                  {(() => {
                    const id = res.data?.identity?.agents[p.label];
                    const reg = res.data?.identity?.identityRegistry;
                    return id === undefined || reg === undefined ? null : (
                      <>
                        <dt>ERC-8004</dt>
                        <dd>
                          Agent{' '}
                          <Proof
                            value={id.agentId}
                            href={etherscanToken(reg, id.agentId)}
                            label="ERC-8004 agent ID"
                            full
                          />
                        </dd>
                      </>
                    );
                  })()}
                  <dt>Endpoint</dt>
                  <dd>
                    <code className="wrap">{p.endpoint}</code>
                    {p.endpoint.startsWith('http://127.0.0.1') ||
                    p.endpoint.startsWith('http://localhost') ? (
                      <span className="hint"> (local provider service)</span>
                    ) : null}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      {res.data === null ? null : (
        <>
          <IdentityRecord identity={res.data.identity} />
          <SetupsRecord record={res.data.ensSetups} />
        </>
      )}
    </>
  );
}
