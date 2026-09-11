import type { Metadata } from './types';

/** Shorten the source's owner label for display; never change ASN identity. */
export function providerName(asn: number, asns: Metadata['asns']): string {
  const owner = asns.find(network => network.asn === asn)?.name?.trim();
  if (!owner) return `AS${asn}`;
  // RIPE commonly returns "registry handle - organization, country code".
  const separator = owner.indexOf(' - ');
  const organization = separator >= 0 ? owner.slice(separator + 3) : owner;
  return organization
    .replace(/,\s*[A-Z]{2}$/, '')
    .replace(/,?\s+(?:Inc\.?|LLC|Ltd\.?|Limited)$/, '')
    .replace(/[,\s]+$/, '')
    .trim() || `AS${asn}`;
}
