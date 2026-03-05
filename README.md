# 🛣️ Endringsmelding-Appen

Sammenlign NVDB V2-rapporter og generer endringsmeldinger for byggemøter.

## Hva gjør appen?

Last opp to NVDB V2-rapporter (grunnlag og nåværende), og appen beregner
netto endring per objektkategori — sortert etter størst differanse.
Velg relevante rader og send direkte til e-post med ferdig vedlegg.

---

## Kjøre lokalt

```bash
npm install
npm run dev
```

Åpne http://localhost:5173 i nettleseren.

---

## Publisere på GitHub Pages (én gang)

### 1. Opprett repository på GitHub

Gå til https://github.com/new og opprett et nytt **offentlig** repository,
f.eks. `endringsmelding-app`. Ikke initialiser med README.

### 2. Koble til og push koden

```bash
git init
git add .
git commit -m "første versjon"
git branch -M main
git remote add origin https://github.com/DITT-BRUKERNAVN/endringsmelding-app.git
git push -u origin main
```

*(Bytt ut `DITT-BRUKERNAVN` med ditt GitHub-brukernavn)*

### 3. Aktiver GitHub Pages

1. Gå til repoet på GitHub
2. Klikk **Settings** → **Pages** (i venstremenyen)
3. Under **Source**, velg **GitHub Actions**
4. Lagre

GitHub Actions bygger og deployer appen automatisk. Etter 1–2 minutter
er appen tilgjengelig på:

```
https://DITT-BRUKERNAVN.github.io/endringsmelding-app/
```

### 4. Del lenken med kolleger 🎉

Appen kjører helt i nettleseren — ingen server, ingen innlogging.
NVDB-filene lastes aldri opp til noe sted, de leses kun lokalt.

---

## Oppdatere appen senere

```bash
# Gjør endringer i src/App.jsx, deretter:
git add .
git commit -m "beskrivelse av endring"
git push
```

GitHub Actions deployer automatisk.

---

## Filstruktur

```
endringsmelding-app/
├── src/
│   ├── App.jsx        ← hele appen (én fil)
│   └── main.jsx       ← React-inngangspunkt
├── index.html
├── vite.config.js
├── package.json
├── .gitignore
└── .github/
    └── workflows/
        └── deploy.yml ← automatisk deploy
```

## Teknisk stack

- [React 18](https://react.dev/) + [Vite](https://vitejs.dev/)
- [SheetJS (xlsx)](https://sheetjs.com/) for Excel-parsing
- Google Fonts: Sora + JetBrains Mono
- Ingen backend — alt kjører i nettleseren
