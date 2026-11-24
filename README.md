# Ink Bleed

Herramienta para convertir arte vectorial / tipografía (tinta negra sobre blanco) en un print con tinta
corrida, tipo spray / ink bleed, que reacciona a la textura del papel que tiene atrás.
Todos los parámetros se controlan con [DialKit](https://www.dialkit.dev/).

```bash
npm install
npm run dev
```

## Uso

- **Input**: escribí texto (`/` = salto de línea) o subí una imagen en *Artwork*. También podés
  **arrastrar una imagen** al canvas.
- **Paper**: textura procedural (fibras, rugosidad, manchas, polvo), una **imagen de textura propia**
  (*Texture*, o arrastrá con **Alt** apretado) o papel liso.
- **Output → Download PNG** exporta a la resolución elegida. *Transparent* exporta sólo la tinta con alpha.

## Cómo reacciona al papel

La luminancia de la textura se usa como mapa de altura del papel:

| Efecto | Qué hace |
| --- | --- |
| `bleed.paperInfluence` | Los valles del papel absorben más → la tinta se expande más ahí |
| `bleed.fiberPull` | La tinta se desplaza siguiendo el gradiente del papel (corre por las fibras) |
| `bleed.blotch` | Absorción despareja de baja frecuencia (encolado irregular) |
| `grain.paperTooth` | El relieve del papel no recibe tinta → se ve la textura dentro de las letras |

## Pipeline (WebGL2)

1. **paper** – color + altura (procedural o imagen)
2. **mask** – cobertura de tinta del artwork, deformada por ruido y por el gradiente del papel; absorción por píxel
3. **core blur** – gaussiano separable full-res, sigma modulado por absorción
4. **halo blur** – lo mismo a 1/4 de resolución para el difuminado ancho
5. **composite** – umbral estocástico (grano de spray), tooth del papel, salpicaduras, multiply sobre el papel

Los tamaños están expresados en píxeles cada 1000 px del lado largo, así el look se mantiene al cambiar la resolución.
