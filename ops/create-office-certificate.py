"""签发只用于本机工作台的内网证书。根证书签名私钥只存在于本次进程。"""
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address, ip_network
from pathlib import Path
from sys import argv

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

host, output, public_root = ip_address(argv[1]), Path(argv[2]), Path(argv[3])
allowed = [ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
if host.version != 4 or not any(host in network for network in allowed):
    raise SystemExit('请输入已确认的办公室 IPv4 私网地址')
targets = (output / 'https-cert.pem', output / 'https-key.pem', public_root)
if any(path.exists() for path in targets):
    raise SystemExit('证书输出文件已存在，请核对现有证书')

now = datetime.now(timezone.utc)
start, end = now - timedelta(minutes=5), now + timedelta(days=365)
ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'电脑租赁工作台内网 {host}')])
server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, str(host))])


def certificate(subject, issuer, key):
    return (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(end))


root = (certificate(ca_name, ca_name, ca_key)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256()))
leaf = (certificate(server_name, ca_name, server_key)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(host), x509.IPAddress(ip_address('127.0.0.1'))]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256()))

with targets[0].open('xb') as stream:
    stream.write(leaf.public_bytes(serialization.Encoding.PEM) + root.public_bytes(serialization.Encoding.PEM))
with targets[1].open('xb') as stream:
    stream.write(server_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
with targets[2].open('xb') as stream:
    stream.write(root.public_bytes(serialization.Encoding.DER))
print(f'证书有效至 {end.date()}，SHA-256 {root.fingerprint(hashes.SHA256()).hex().upper()}')
