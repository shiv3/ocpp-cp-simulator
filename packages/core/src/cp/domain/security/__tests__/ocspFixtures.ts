/**
 * #537 (M06): a real DER OCSPResponse (RFC 6960), base64 as it travels in
 * GetCertificateStatusResponse.ocspResult (M06.FR.08/09). The station
 * caches it as received, so its content only has to be realistic.
 *
 * Produced with OpenSSL 4.1: an EC P-256 "V2G Sub-CA" signs a leaf with
 * serial 0x0a1b and an AIA OCSP URI http://ocsp.example.com/, then
 * `openssl ocsp -index index.txt -CA ca.pem -rsigner ca.pem -rkey ca.key
 * -issuer ca.pem -serial 0x0a1b -respout resp.der -ndays 3650`.
 * Response status successful, certificate status good.
 */
export const OCSP_RESPONSE_GOOD_BASE64 =
  "MIICzgoBAKCCAscwggLDBgkrBgEFBQcwAQEEggK0MIICsDCByKEpMCcxEzARBgNVBAMMClYyRyBTdWItQ0ExEDAOBgNVBAoMB0V4YW1wbGUYDzIwMjYxMDMwMDkwMTI0WjBlMGMwOzAJBgUrDgMCGgUABBRwj8iacJrRro2dEFTg0xzvVwyPlgQUr4VmqremWh5WgSW5DnMlszq8PRUCAgobgAAYDzIwMjYxMDMwMDkwMTI0WqARGA8yMDM2MTAyNzA5MDEyNFqhIzAhMB8GCSsGAQUFBzABAgQSBBC7ovbcmTYvfUW81AVvQRhxMAoGCCqGSM49BAMCA0kAMEYCIQDz2StWNsFP+8+B643ib6LAJ8SHI1tObL6gPIEkQ00gcQIhAL/JB28BDt/RNMLl1b23JnvRLO9qej22qAcCsduei1dUoIIBijCCAYYwggGCMIIBKKADAgECAhRGyNInAryMYJqiTmUgDfb9WP2z2TAKBggqhkjOPQQDAjAnMRMwEQYDVQQDDApWMkcgU3ViLUNBMRAwDgYDVQQKDAdFeGFtcGxlMB4XDTI2MTAzMDA5MDEyNFoXDTM2MTAyNzA5MDEyNFowJzETMBEGA1UEAwwKVjJHIFN1Yi1DQTEQMA4GA1UECgwHRXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPxqRmggllgWF6pWHNw/4rph6JYeCWFOM16W4cbd1XyM80+rEfVgUY0jLBqPk25Y0khcQyFFuzzKh6Fi68LMUAOjMjAwMB0GA1UdDgQWBBSvhWaqt6ZaHlaBJbkOcyWzOrw9FTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIF9BomznRKOd1B0V1lXZLlULSujzCknHP/X55QcNz32vAiEAs3frPNqIAIjz01GZX/OmBUptr/1t3uHg8zjPMB3pQos=";
