"""Device identity and pairwise trust for Herald's peer mesh.

Every Herald node has its own Ed25519 identity, generated once and kept in
the encrypted SecretVault. Other nodes discovered on the network (see
mesh_discovery.py) show up here as 'pending' until a human approves them
from an already-trusted node -- at which point a bearer token is minted and
handed to the approved device, and future requests from it authenticate
with that token (see server.py's require_public_bind_token).

Trust is pairwise and local to this node in this first build: approving a
device here does not automatically trust it on any other Herald node.
"""
from __future__ import annotations

import hashlib
import base64
import json
import secrets
import sqlite3
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone

UTC = timezone.utc
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization

from herald.router.storage_paths import database_path

DEFAULT_DB_PATH = database_path(
    "devices.db",
    env_var="HERALD_DEVICES_DB",
    legacy_path=Path(__file__).resolve().parent / "devices.db",
)
STATUSES = {"self", "pending", "trusted", "revoked"}
_VAULT_KEY_NAME = "mesh-node-privkey"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def short_code(public_key_pem: str) -> str:
    """A short, human-comparable fingerprint derived from a public key.

    Deterministic from the key alone so both sides of a pairing can compute
    it independently -- it is never transmitted as a secret, it's what a
    human visually compares between two screens.
    """
    digest = hashlib.sha256(public_key_pem.encode()).hexdigest().upper()
    return "-".join(digest[i:i+3] for i in range(0,12,3))


@dataclass
class Device:
    node_id: str
    display_name: str
    hostname: str
    public_key_pem: str
    status: str
    short_code: str
    first_seen: str
    approved_at: str | None
    last_seen: str
    bearer_token: str | None
    address: str | None = None
    port: int | None = None
    grant_revision: int = 0
    remote_grant_ref: str | None = None
    remote_grant_revision: int = 0
    remote_grant_digest: str | None = None

    def to_dict(self, *, reveal_token: bool = False) -> dict[str, Any]:
        data = {
            "node_id": self.node_id,
            "display_name": self.display_name,
            "hostname": self.hostname,
            "status": self.status,
            "short_code": self.short_code,
            "first_seen": self.first_seen,
            "approved_at": self.approved_at,
            "last_seen": self.last_seen,
            "remote_access_granted": bool(self.remote_grant_ref and self.status != "revoked"),
        }
        if reveal_token:
            data["bearer_token"] = self.bearer_token
        return data


class MeshTrust:
    def __init__(self, db_path: str | Path = DEFAULT_DB_PATH, *, vault_root: str | Path | None = None):
        self.db_path = str(db_path)
        self._vault_root = vault_root
        self._init_schema()

    def _vault(self):
        from herald.router.secret_vault import SecretVault
        if self._vault_root is not None:
            return SecretVault(self._vault_root)
        # Deliberately data_dir()-scoped, not SecretVault's own home-relative
        # default: two Herald installs on one machine (HERALD_DATA_DIR set
        # differently for each) must never share -- and thus collide on --
        # the same node identity.
        from herald.router.storage_paths import data_dir
        return SecretVault(data_dir() / "vault")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_schema(self) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                    node_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    hostname TEXT NOT NULL,
                    public_key_pem TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    short_code TEXT NOT NULL,
                    first_seen TEXT NOT NULL,
                    approved_at TEXT,
                    last_seen TEXT NOT NULL,
                    bearer_token TEXT,
                    address TEXT,
                    port INTEGER
                )
            """)
            conn.execute("BEGIN IMMEDIATE")
            columns={row["name"] for row in conn.execute("PRAGMA table_info(devices)")}
            for name, declaration in (("grant_revision","INTEGER NOT NULL DEFAULT 0"),
                                      ("remote_grant_ref","TEXT"),
                                      ("remote_grant_revision","INTEGER NOT NULL DEFAULT 0"),
                                      ("remote_grant_digest","TEXT")):
                if name not in columns:conn.execute(f"ALTER TABLE devices ADD COLUMN {name} {declaration}")
            for row in conn.execute("SELECT node_id,public_key_pem,short_code FROM devices").fetchall():
                code=short_code(row["public_key_pem"])
                if row["short_code"] != code:
                    conn.execute("UPDATE devices SET short_code=? WHERE node_id=?",(code,row["node_id"]))
            conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_short_code ON devices(short_code)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(bearer_token)")

    @staticmethod
    def _row_to_device(row: sqlite3.Row) -> Device:
        keys = row.keys()
        return Device(
            node_id=row["node_id"], display_name=row["display_name"], hostname=row["hostname"],
            public_key_pem=row["public_key_pem"], status=row["status"], short_code=row["short_code"],
            first_seen=row["first_seen"], approved_at=row["approved_at"], last_seen=row["last_seen"],
            bearer_token=row["bearer_token"],
            grant_revision=row["grant_revision"], remote_grant_ref=row["remote_grant_ref"],
            remote_grant_revision=row["remote_grant_revision"],remote_grant_digest=row["remote_grant_digest"],
            address=row["address"] if "address" in keys else None,
            port=row["port"] if "port" in keys else None,
        )

    def self_identity(self) -> Device:
        """This node's own identity, generating and persisting a keypair on first call."""
        with closing(self._connect()) as conn, conn:
            row = conn.execute("SELECT * FROM devices WHERE status = 'self'").fetchone()
            if row is not None:
                return self._row_to_device(row)

        vault = self._vault()
        try:
            private_bytes = vault.get(_VAULT_KEY_NAME)
            private_key = Ed25519PrivateKey.from_private_bytes(private_bytes)
        except KeyError:
            private_key = Ed25519PrivateKey.generate()
            private_bytes = private_key.private_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PrivateFormat.Raw,
                encryption_algorithm=serialization.NoEncryption(),
            )
            vault.put(_VAULT_KEY_NAME, private_bytes)

        public_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()

        import socket
        node_id = str(uuid.uuid4())
        hostname = socket.gethostname()
        now = _now_iso()
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """INSERT INTO devices
                   (node_id, display_name, hostname, public_key_pem, status, short_code,
                    first_seen, approved_at, last_seen, bearer_token)
                   VALUES (?, ?, ?, ?, 'self', ?, ?, ?, ?, NULL)""",
                (node_id, hostname, hostname, public_pem, short_code(public_pem), now, now, now),
            )
        return Device(
            node_id=node_id, display_name=hostname, hostname=hostname, public_key_pem=public_pem,
            status="self", short_code=short_code(public_pem), first_seen=now, approved_at=now,
            last_seen=now, bearer_token=None,
        )

    def sign(self, message: bytes) -> bytes:
        """Sign a message with this node's private key (for the approve callback)."""
        self.self_identity()  # ensure a keypair exists
        private_bytes = self._vault().get(_VAULT_KEY_NAME)
        return Ed25519PrivateKey.from_private_bytes(private_bytes).sign(message)

    @staticmethod
    def verify(public_key_pem: str, message: bytes, signature: bytes) -> bool:
        try:
            public_key = serialization.load_pem_public_key(public_key_pem.encode())
            if not isinstance(public_key, Ed25519PublicKey):
                return False
            public_key.verify(signature, message)
            return True
        except Exception:  # noqa: BLE001 - any crypto/parse failure means "not verified"
            return False

    def observe(
        self, node_id: str, display_name: str, hostname: str, public_key_pem: str,
        *, address: str | None = None, port: int | None = None,
    ) -> Device:
        """Record a peer seen via discovery. Leaves existing trusted/revoked status alone."""
        now = _now_iso()
        with closing(self._connect()) as conn, conn:
            existing = conn.execute("SELECT * FROM devices WHERE node_id = ?", (node_id,)).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO devices
                       (node_id, display_name, hostname, public_key_pem, status, short_code,
                        first_seen, approved_at, last_seen, bearer_token, address, port)
                       VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL, ?, ?)""",
                    (node_id, display_name, hostname, public_key_pem, short_code(public_key_pem),
                     now, now, address, port),
                )
            else:
                conn.execute(
                    "UPDATE devices SET last_seen = ?, address = ?, port = ? WHERE node_id = ?",
                    (now, address, port, node_id),
                )
            row = conn.execute("SELECT * FROM devices WHERE node_id = ?", (node_id,)).fetchone()
        return self._row_to_device(row)

    def pending(self) -> list[Device]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT * FROM devices WHERE status = 'pending' ORDER BY first_seen").fetchall()
        return [self._row_to_device(row) for row in rows]

    def trusted(self) -> list[Device]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM devices WHERE status = 'trusted' ORDER BY approved_at DESC"
            ).fetchall()
        return [self._row_to_device(row) for row in rows]

    def get(self, node_id: str) -> Device | None:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT * FROM devices WHERE node_id = ?", (node_id,)).fetchone()
        return self._row_to_device(row) if row is not None else None

    def find_by_code(self, code: str) -> Device | None:
        normalized = code.strip().upper()
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM devices WHERE short_code = ? AND status = 'pending'", (normalized,)
            ).fetchall()
        if len(rows) > 1:
            raise ValueError("pairing code is ambiguous; select a device by node identity")
        row = rows[0] if rows else None
        return self._row_to_device(row) if row is not None else None

    def approve(self, node_id: str, *, expected_code: str | None = None) -> Device:
        token = secrets.token_urlsafe(32)
        now = _now_iso()
        with closing(self._connect()) as conn, conn:
            cursor = conn.execute(
                """UPDATE devices SET status = 'trusted', approved_at = ?, bearer_token = ?, grant_revision=grant_revision+1
                   WHERE node_id = ? AND status IN ('pending', 'trusted')
                   AND (? IS NULL OR (status = 'pending' AND short_code = ?))""",
                (now, token, node_id, expected_code,
                 expected_code.strip().upper() if expected_code is not None else None),
            )
            if cursor.rowcount != 1:
                if conn.execute("SELECT 1 FROM devices WHERE node_id = ?", (node_id,)).fetchone() is None:
                    raise KeyError(f"unknown device '{node_id}'")
                raise ValueError("device is no longer eligible for this approval")
            row = conn.execute("SELECT * FROM devices WHERE node_id = ?", (node_id,)).fetchone()
        if row is None:
            raise KeyError(f"unknown device '{node_id}'")
        return self._row_to_device(row)

    def revoke(self, node_id: str) -> Device:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "UPDATE devices SET status = 'revoked', bearer_token = NULL, remote_grant_ref=NULL, remote_grant_digest=NULL WHERE node_id = ?",
                (node_id,),
            )
            row = conn.execute("SELECT * FROM devices WHERE node_id = ?", (node_id,)).fetchone()
        if row is None:
            raise KeyError(f"unknown device '{node_id}'")
        return self._row_to_device(row)

    def authenticate_token(self, token: str) -> Device | None:
        """Look up a trusted device by its bearer token, for request auth."""
        if not token:
            return None
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT * FROM devices WHERE bearer_token = ? AND status = 'trusted'", (token,)
            ).fetchone()
        return self._row_to_device(row) if row is not None else None

    @staticmethod
    def grant_message(approver: str, recipient: str, ciphertext: str) -> bytes:
        return json.dumps(["herald.mesh.grant.v2",approver,recipient,ciphertext],separators=(",",":")).encode()

    def seal_grant(self, approved: Device) -> dict[str, Any]:
        from nacl.public import SealedBox
        from nacl.signing import VerifyKey
        peer=serialization.load_pem_public_key(approved.public_key_pem.encode())
        if not isinstance(peer,Ed25519PublicKey):raise ValueError("peer identity is not Ed25519")
        identity=self.self_identity()
        payload=json.dumps({"approver_node_id":identity.node_id,"recipient_node_id":approved.node_id,
                            "bearer_token":approved.bearer_token,"grant_revision":approved.grant_revision},
                           separators=(",",":")).encode()
        key=VerifyKey(peer.public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)).to_curve25519_public_key()
        ciphertext=base64.b64encode(SealedBox(key).encrypt(payload)).decode()
        signature=self.sign(self.grant_message(identity.node_id,approved.node_id,ciphertext))
        return {"version":2,"approver_node_id":identity.node_id,
                "approver_public_key_pem":identity.public_key_pem,"recipient_node_id":approved.node_id,
                "sealed_grant":ciphertext,"signature":base64.b64encode(signature).decode()}

    def open_grant(self, *, approver_node_id: str, recipient_node_id: str,
                   approver_public_key_pem: str, sealed_grant: str, signature: str) -> dict[str, Any]:
        from nacl.public import SealedBox
        from nacl.signing import SigningKey
        from nacl.exceptions import CryptoError
        known=self.get(approver_node_id)
        if known is None or known.status == "revoked" or known.public_key_pem != approver_public_key_pem:
            raise PermissionError("grant identity does not match a permitted discovered peer")
        identity=self.self_identity()
        if recipient_node_id != identity.node_id:raise PermissionError("grant is addressed to another node")
        try:
            sig=base64.b64decode(signature,validate=True)
            if not self.verify(known.public_key_pem,self.grant_message(approver_node_id,recipient_node_id,sealed_grant),sig):
                raise PermissionError("grant signature does not match the pinned peer")
            private=SigningKey(self._vault().get(_VAULT_KEY_NAME)).to_curve25519_private_key()
            payload=json.loads(SealedBox(private).decrypt(base64.b64decode(sealed_grant,validate=True)))
        except (ValueError,TypeError,CryptoError) as exc:
            raise PermissionError("grant could not be authenticated and decrypted") from exc
        if (not isinstance(payload,dict) or payload.get("approver_node_id") != approver_node_id or
            payload.get("recipient_node_id") != recipient_node_id or
            not isinstance(payload.get("bearer_token"),str) or not 20 <= len(payload["bearer_token"]) <= 256 or
            type(payload.get("grant_revision")) is not int or payload["grant_revision"] < 1):
            raise PermissionError("invalid grant payload")
        return payload

    def accept_remote_grant(self, *, approver_node_id: str, approver_public_key_pem: str,
                           my_bearer_token: str, grant_revision: int) -> None:
        """Keep an outbound credential; never grant the sender inbound authority."""
        if type(grant_revision) is not int or grant_revision < 1 or not isinstance(my_bearer_token,str) or not my_bearer_token:
            raise ValueError("invalid remote grant")
        digest=hashlib.sha256(my_bearer_token.encode()).hexdigest()
        with closing(self._connect()) as conn,conn:
            conn.execute("BEGIN IMMEDIATE")
            row=conn.execute("SELECT * FROM devices WHERE node_id=?",(approver_node_id,)).fetchone()
            if row is None or row["status"] == "revoked" or row["public_key_pem"] != approver_public_key_pem:
                raise PermissionError("remote grant peer is unknown, revoked, or changed")
            if grant_revision < row["remote_grant_revision"]:
                raise ValueError("remote grant is older than the stored grant")
            if grant_revision == row["remote_grant_revision"]:
                if digest != row["remote_grant_digest"]:raise ValueError("remote grant revision conflicts")
                return
            name="mesh-outbound/"+approver_node_id+"/"+str(grant_revision)+"/"+digest
            ref=self._vault().put(name,my_bearer_token.encode(),metadata={"kind":"mesh-outbound-grant"})
            conn.execute("""UPDATE devices SET remote_grant_ref=?,remote_grant_revision=?,remote_grant_digest=?,last_seen=?
                            WHERE node_id=?""",(ref,grant_revision,digest,_now_iso(),approver_node_id))

    def remote_grant_token(self, node_id: str) -> str | None:
        peer=self.get(node_id)
        if peer is None or peer.status == "revoked" or not peer.remote_grant_ref:return None
        return self._vault().get(peer.remote_grant_ref.removeprefix("vault:")).decode()
