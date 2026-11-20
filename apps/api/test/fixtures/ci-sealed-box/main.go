// Command fixture writes sealed-box.json: a value sealed the way `gh secret
// set` seals it (golang.org/x/crypto/nacl/box.SealAnonymous), for the API's
// sealed-box tests. The values are test data, not secrets.
//
// Everything is deterministic, so a regeneration reproduces the committed file:
//   - the recipient private key is SHA-256("fyrden ci sealed-box fixture: recipient");
//   - the ephemeral key SealAnonymous draws comes from SHA-256("fyrden ci sealed-box
//     fixture: ephemeral") instead of crypto/rand.
//
// Regenerate from this directory with `GOTOOLCHAIN=local go run . > sealed-box.json`.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

const plaintext = "fyrden sealed-box fixture: ünïcödé ✓, a tab\tand a newline\n"

type fixture struct {
	Comment    string `json:"comment"`
	PrivateKey string `json:"privateKey"`
	PublicKey  string `json:"publicKey"`
	Plaintext  string `json:"plaintext"`
	Sealed     string `json:"sealed"`
}

func main() {
	privateKey := sha256.Sum256([]byte("fyrden ci sealed-box fixture: recipient"))
	publicKeySlice, err := curve25519.X25519(privateKey[:], curve25519.Basepoint)
	if err != nil {
		panic(err)
	}
	var publicKey [32]byte
	copy(publicKey[:], publicKeySlice)
	ephemeral := sha256.Sum256([]byte("fyrden ci sealed-box fixture: ephemeral"))
	sealed, err := box.SealAnonymous(nil, []byte(plaintext), &publicKey, bytes.NewReader(ephemeral[:]))
	if err != nil {
		panic(err)
	}
	out := fixture{
		Comment:    "Test data made by main.go in this directory (golang.org/x/crypto/nacl/box.SealAnonymous); not a secret.",
		PrivateKey: base64.StdEncoding.EncodeToString(privateKey[:]),
		PublicKey:  base64.StdEncoding.EncodeToString(publicKey[:]),
		Plaintext:  plaintext,
		Sealed:     base64.StdEncoding.EncodeToString(sealed),
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(out); err != nil {
		panic(err)
	}
}
