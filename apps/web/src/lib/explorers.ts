/** Public explorer links for proofs. Pure; every URL is https on a fixed host. */

export type HederaNetwork = 'testnet' | 'mainnet';

export const hashscanTransaction = (network: HederaNetwork, transactionId: string): string =>
  `https://hashscan.io/${network}/transaction/${encodeURIComponent(transactionId)}`;

export const hashscanAccount = (network: HederaNetwork, accountId: string): string =>
  `https://hashscan.io/${network}/account/${encodeURIComponent(accountId)}`;

/** HashScan for an HCS topic, or null if it is not an entity ID. */
export const hashscanTopic = (network: HederaNetwork, topicId: string): string | null =>
  /^0\.0\.\d{1,12}$/.test(topicId) ? `https://hashscan.io/${network}/topic/${topicId}` : null;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Sepolia Etherscan for an address, or null if it is not an address. */
export const etherscanAddress = (address: string): string | null =>
  ADDRESS.test(address) ? `https://sepolia.etherscan.io/address/${address}` : null;

/** Sepolia Etherscan for a block number, or null if it is not one. */
export const etherscanBlock = (block: string): string | null =>
  /^\d{1,12}$/.test(block) ? `https://sepolia.etherscan.io/block/${block}` : null;

/** Sepolia Etherscan for one ERC-721 token (an ERC-8004 agent ID), or null. */
export const etherscanToken = (contract: string, tokenId: string): string | null =>
  ADDRESS.test(contract) && /^\d{1,78}$/.test(tokenId)
    ? `https://sepolia.etherscan.io/token/${contract}?a=${tokenId}`
    : null;

/**
 * A link that came from the API, kept only if it is https (D-060). The server
 * builds these from validated IDs, but a link the page cannot vouch for never
 * becomes a javascript: or data: URL.
 */
export const safeHref = (href: string | null | undefined): string | null =>
  typeof href === 'string' && /^https:\/\/[^\s]+$/.test(href) ? href : null;
