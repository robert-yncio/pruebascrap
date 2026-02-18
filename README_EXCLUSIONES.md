# Funcionalidad de Exclusiones - LinkedIn Scraper

## Descripción

Se ha agregado una nueva funcionalidad que permite excluir perfiles específicos de LinkedIn durante las búsquedas. Esto es útil para:

- Evitar procesar perfiles ya contactados
- Excluir perfiles que no son relevantes para la búsqueda actual
- Mantener listas de perfiles a omitir en futuras búsquedas
- Optimizar el tiempo de procesamiento

## Uso

### Parámetros de línea de comandos

```bash
--exclude=urls_o_archivo    # URLs separadas por coma O archivo con URLs
--exclude-urls=urls         # URLs separadas por coma (específico para URLs)
--exclude-file=archivo      # Archivo con URLs a excluir (específico para archivos)
```

### Ejemplos de uso

#### Búsqueda individual con exclusiones por URLs directas
```bash
# URLs directas separadas por coma
node index.js "Juan Pérez" --exclude="linkedin.com/in/usuario1,linkedin.com/in/usuario2"
node index.js "María García" --exclude-urls="https://linkedin.com/in/excluir1,linkedin.com/in/excluir2"

# URLs con diferentes formatos (se normalizan automáticamente)
node index.js "Carlos López" --exclude="www.linkedin.com/in/user1,https://linkedin.com/in/user2?param=1"
```

#### Búsqueda individual con exclusiones desde archivo
```bash
node index.js "Juan Pérez" --exclude-file="exclusiones.json"
node index.js "María García" --exclude="perfiles_excluir.txt"
```

#### Búsqueda masiva con exclusiones
```bash
# Desde archivo
node index.js nombres.json --exclude-file="ya_contactados.json"
node index.js candidatos.csv --keywords="desarrollador" --exclude="no_relevantes.txt"

# URLs directas
node index.js nombres.json --exclude="linkedin.com/in/user1,linkedin.com/in/user2"
```

#### Combinando con otros filtros
```bash
node index.js nombres.json --keywords="marketing,digital" --max=20 --exclude-file="contactados.json" --delay=3
node index.js candidatos.csv --keywords="ingeniero" --exclude="linkedin.com/in/excluir1,linkedin.com/in/excluir2"
```

## Métodos de exclusión

### 1. URLs directas en línea de comandos

Puedes especificar URLs directamente en la línea de comandos, separadas por comas:

```bash
# Usando --exclude (detecta automáticamente si es archivo o URLs)
node index.js "Juan" --exclude="linkedin.com/in/user1,linkedin.com/in/user2"

# Usando --exclude-urls (específico para URLs)
node index.js "María" --exclude-urls="https://linkedin.com/in/excluir1,linkedin.com/in/excluir2"
```

**Formatos de URL soportados:**
- `linkedin.com/in/usuario/`
- `www.linkedin.com/in/usuario/`
- `https://linkedin.com/in/usuario/`
- `https://www.linkedin.com/in/usuario/?param=value` (se normaliza automáticamente)

### 2. Desde archivo

Especifica un archivo que contenga las URLs a excluir:

```bash
# Usando --exclude-file (específico para archivos)
node index.js "Juan" --exclude-file="exclusiones.json"

# Usando --exclude (detecta automáticamente si es archivo o URLs)
node index.js "María" --exclude="perfiles_excluir.txt"
```

## Formatos de archivo soportados

### JSON
El archivo puede contener:

1. **Array simple de URLs:**
```json
[
  "https://www.linkedin.com/in/usuario1/",
  "https://www.linkedin.com/in/usuario2/",
  "linkedin.com/in/usuario3/"
]
```

2. **Objeto con propiedad 'urls':**
```json
{
  "urls": [
    "https://www.linkedin.com/in/usuario1/",
    "https://www.linkedin.com/in/usuario2/"
  ]
}
```

3. **Objeto con propiedad 'exclusiones':**
```json
{
  "exclusiones": [
    "https://www.linkedin.com/in/usuario1/",
    "https://www.linkedin.com/in/usuario2/"
  ]
}
```

4. **Array de objetos con URLs:**
```json
[
  {
    "nombre": "Juan Pérez",
    "url": "https://www.linkedin.com/in/juan-perez/",
    "motivo": "Ya contactado"
  },
  {
    "nombre": "María García", 
    "urlPerfil": "https://www.linkedin.com/in/maria-garcia/",
    "fecha": "2024-01-15"
  }
]
```

### TXT/CSV
Una URL por línea:

```txt
# Lista de perfiles a excluir
# Las líneas que empiecen con # son comentarios

https://www.linkedin.com/in/usuario1/
https://www.linkedin.com/in/usuario2/
linkedin.com/in/usuario3/
www.linkedin.com/in/usuario4/
```

## Detección automática

El parámetro `--exclude` detecta automáticamente si el valor es:

- **Archivo**: Si contiene un punto (.) y NO contiene "linkedin.com"
  - Ejemplo: `--exclude="exclusiones.json"` → Se trata como archivo
  - Ejemplo: `--exclude="lista.txt"` → Se trata como archivo

- **URLs directas**: Si contiene "linkedin.com" o no tiene extensión de archivo
  - Ejemplo: `--exclude="linkedin.com/in/user1,linkedin.com/in/user2"` → Se trata como URLs
  - Ejemplo: `--exclude="user1,user2"` → Se trata como URLs (se agrega linkedin.com/in/)

Para mayor claridad, puedes usar los parámetros específicos:
- `--exclude-urls=` para URLs directas
- `--exclude-file=` para archivos

## Normalización de URLs

El sistema normaliza automáticamente las URLs para asegurar comparaciones correctas:

- Agrega `https://` si no tiene protocolo
- Remueve parámetros de query (`?param=value`)
- Remueve fragmentos (`#section`)
- Remueve barras finales
- Solo procesa URLs que contengan `linkedin.com/in/`

### Ejemplos de normalización:
- `linkedin.com/in/usuario/` → `https://linkedin.com/in/usuario`
- `https://www.linkedin.com/in/usuario/?param=1` → `https://www.linkedin.com/in/usuario`
- `http://linkedin.com/in/usuario#section` → `https://linkedin.com/in/usuario`

## Estadísticas

Cuando se usan exclusiones, el sistema reporta:

```
=== Búsqueda masiva completada ===
Total de búsquedas: 10
Completadas: 10
Fallidas: 0
Perfiles encontrados: 45
Perfiles que coinciden con filtros: 32
Perfiles excluidos: 5
```

## Mensajes de log

Durante la ejecución verás mensajes como:

```
Cargando exclusiones desde: exclusiones.json
✓ Cargadas 15 URLs de exclusión
URLs de exclusión cargadas: 15 perfiles

[1/5] Buscando: Juan Pérez
  Filtrados: 8 de 12 perfiles coinciden con las palabras clave
  Excluidos: 2 perfiles por estar en la lista de exclusiones
  ✓ Encontrados 6 perfiles
```

## Casos de uso comunes

### 1. Lista de ya contactados
Mantén un archivo `contactados.json` con todos los perfiles ya contactados:

```bash
node index.js nuevos_candidatos.json --exclude="contactados.json"
```

### 2. Perfiles no relevantes
Crea `no_relevantes.txt` con perfiles que no coinciden con el perfil buscado:

```bash
node index.js "Director de Marketing" --exclude="no_relevantes.txt"
```

### 3. Exclusiones por proyecto
Mantén archivos separados por proyecto:

```bash
node index.js candidatos.json --exclude="proyecto_a_excluidos.json"
node index.js candidatos.json --exclude="proyecto_b_excluidos.json"
```

## Notas importantes

1. **Rendimiento**: Las exclusiones se aplican después del filtrado por keywords pero antes de obtener detalles completos, optimizando el rendimiento.

2. **Compatibilidad**: La funcionalidad es completamente opcional. Si no se especifica `--exclude`, el comportamiento es idéntico al anterior.

3. **Validación**: Solo se procesan URLs válidas de LinkedIn. URLs malformadas o de otros sitios se ignoran silenciosamente.

4. **Logging**: El sistema informa cuántas URLs se cargaron y cuántos perfiles se excluyeron en cada búsqueda.

5. **Flexibilidad**: Soporta múltiples formatos de archivo para adaptarse a diferentes flujos de trabajo.