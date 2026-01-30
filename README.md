# LinkedIn Scraper

Scraper de LinkedIn para buscar personas por nombre y obtener información de sus perfiles.

## ⚠️ Advertencia Legal

LinkedIn tiene políticas estrictas contra el scraping. Este script es solo para fines educativos. Asegúrate de:
- Respetar los términos de servicio de LinkedIn
- No hacer demasiadas solicitudes en poco tiempo
- Usar tus propias credenciales
- Ser responsable con el uso de los datos obtenidos

## Requisitos

- Node.js 18.20.5 o superior
- npm o yarn

## Instalación

1. Asegúrate de tener Node.js 18.20.5 o superior instalado:
```bash
node --version
```

2. Instala las dependencias:
```bash
npm install
```

3. Crea un archivo `.env` en la raíz del proyecto con tus credenciales de LinkedIn:
```
LINKEDIN_EMAIL=tu_email@ejemplo.com
LINKEDIN_PASSWORD=tu_contraseña
```

## Uso

### Búsqueda individual

La búsqueda es flexible: puedes buscar solo el nombre, nombre completo, etc.

```bash
npm start "Nombre a buscar"
```

Ejemplos:
```bash
npm start "Juan"
npm start "Juan Pérez"
npm start "María"
```

**Por defecto, el sistema obtiene los detalles completos de cada perfil encontrado.**

### Obtener detalles directamente desde URL

Si ya tienes la URL de un perfil de LinkedIn, puedes obtener sus detalles directamente sin hacer búsqueda:

**Opción 1: URL como argumento directo**
```bash
npm start "https://www.linkedin.com/in/usuario/"
```

**Opción 2: Usando el flag --url (con -- para pasar argumentos a npm)**
```bash
npm start -- --url="https://www.linkedin.com/in/usuario/"
```

**Opción 3: Ejecutar directamente con node**
```bash
node index.js --url="https://www.linkedin.com/in/usuario/"
node index.js "https://www.linkedin.com/in/usuario/"
```

**Ejemplos:**
```bash
# Opción más simple: pasar la URL directamente
npm start "https://www.linkedin.com/in/juan-perez/"

# O usando el flag (requiere -- para pasar argumentos a npm)
npm start -- --url="https://www.linkedin.com/in/juan-perez/"

# O ejecutando directamente con node
node index.js --url="https://www.linkedin.com/in/juan-perez/"
```

Esta opción es útil cuando:
- Ya conoces la URL del perfil
- Solo necesitas los datos de una persona específica
- Quieres obtener experiencia laboral y datos personales sin buscar

**Información extraída:**
- Datos personales completos
- Experiencia laboral detallada (puesto, empresa, período, descripción)
- Educación
- Habilidades
- Y toda la información disponible del perfil

### Búsqueda con filtros por palabras clave

Puedes filtrar los resultados por palabras clave que aparezcan en la descripción, título, nombre o ubicación del perfil:

```bash
npm start "Juan" --keywords="desarrollador,javascript"
npm start "María" --filter="marketing,digital"
```

**Ejemplos:**
```bash
# Buscar "Juan" y filtrar por "desarrollador" o "programador"
npm start "Juan" --keywords="desarrollador,programador"

# Buscar "Ana" y filtrar por "marketing" o "digital"
npm start "Ana" --filter="marketing,digital"
```

### Búsqueda masiva desde archivo

Puedes buscar múltiples personas desde un archivo JSON, CSV o TXT:

**Desde archivo JSON:**
```bash
npm start nombres_ejemplo.json
npm start nombres_ejemplo.json --keywords="ingeniero,software"
```

**Desde archivo CSV o TXT:**
```bash
npm start nombres_ejemplo.csv
npm start nombres_ejemplo.csv --keywords="marketing,digital" --delay=10
npm start nombres_ejemplo.txt --filter="desarrollador" --max=20
```

**Opciones disponibles:**
- `--details` o `-d`: Obtener detalles completos (por defecto: activado)
- `--keywords=palabras` o `--filter=palabras`: Filtrar por palabras clave (separadas por coma)
- `--max=N`: Máximo de perfiles por búsqueda (default: 25)
- `--delay=N`: Delay en segundos entre búsquedas (default: 5 segundos)
- `--url=URL`: Obtener detalles directamente desde URL de perfil
- `--clear-session` o `--clear`: Limpiar sesión guardada (forzar nuevo login)

**Formato de archivos:**

JSON (`nombres.json`):
```json
[
  "Juan Pérez",
  "María García",
  "Carlos Rodríguez"
]
```

CSV/TXT (`nombres.csv` o `nombres.txt`):
```
Juan Pérez
María García
Carlos Rodríguez
```

El script:
1. Verificará si hay una sesión activa guardada
2. Si no hay sesión, iniciará sesión en LinkedIn con tus credenciales (solo la primera vez)
3. Guardará las cookies de la sesión para futuras ejecuciones
4. Buscará personas con los nombres especificados (búsqueda flexible: solo nombre o nombre completo)
5. **Obtendrá automáticamente los detalles completos de cada perfil encontrado**
6. Si se especifican palabras clave, filtrará los resultados
7. Guardará los resultados en un archivo JSON con estadísticas

### Persistencia de Sesión

El scraper guarda automáticamente las cookies de la sesión en el archivo `linkedin_cookies.json`. Esto significa que:

- **Primera ejecución**: Hará login con tus credenciales y guardará la sesión
- **Ejecuciones siguientes**: Usará la sesión guardada sin necesidad de hacer login nuevamente
- **Sesión expirada**: Si la sesión expira, automáticamente intentará hacer login de nuevo

Para forzar un nuevo login (por ejemplo, si cambias de cuenta):
```bash
npm start --clear-session
```

### Información extraída

**Por defecto, el sistema obtiene automáticamente los detalles completos de cada perfil:**

**Información básica (de la búsqueda):**
- Nombre
- Título/Posición actual
- Ubicación
- Descripción breve
- URL del perfil
- Imagen de perfil

**Detalles completos (obtenidos automáticamente):**

**Información básica:**
- Nombre completo
- Headline (título profesional)
- Ubicación
- Acerca de (descripción completa)
- Imagen de perfil
- URL del perfil

**Información de contacto (si está disponible):**
- Email
- Teléfono
- Sitio web

**Experiencia laboral detallada:**
- Puesto/Posición
- Empresa
- Período de trabajo
- Ubicación del trabajo
- Descripción detallada
- Duración
- Tipo de empleo (tiempo completo, parcial, etc.)

**Educación detallada:**
- Institución
- Título/Grado
- Período de estudios
- Descripción adicional
- Logros y calificaciones

**Habilidades:**
- Nombre de la habilidad
- Número de endorsements (recomendaciones)

**Certificaciones:**
- Nombre de la certificación
- Organización emisora
- Fecha de obtención
- ID de credencial

**Proyectos:**
- Nombre del proyecto
- Descripción
- Fecha
- URL del proyecto

**Idiomas:**
- Idioma
- Nivel de dominio

**Voluntariado:**
- Organización
- Rol
- Período
- Descripción

**Cursos:**
- Lista de cursos completados

**Publicaciones:**
- Título
- Autores
- Fecha
- Descripción
- URL

**Premios y reconocimientos:**
- Título del premio
- Organización
- Fecha
- Descripción

**Organizaciones:**
- Nombre de la organización
- Rol
- Período

**Patentes:**
- Título
- Número de patente
- Fecha
- Descripción

**Recomendaciones:**
- Número de recomendaciones recibidas
- Número de recomendaciones dadas

### Filtrado por palabras clave

El filtrado busca las palabras clave en:
- **Descripción breve** del perfil
- **Título/Posición** actual
- **Nombre** del perfil
- **Ubicación**

Si alguna de las palabras clave especificadas aparece en cualquiera de estos campos, el perfil se incluirá en los resultados.

**Ejemplo:**
```bash
# Buscará "Juan" y solo mostrará perfiles que contengan "desarrollador" o "javascript" 
# en su descripción, título, nombre o ubicación
npm start "Juan" --keywords="desarrollador,javascript"
```

## Estructura del código

La clase `LinkedInScraper` incluye los siguientes métodos:

- `init()`: Inicializa el navegador
- `login(email, password)`: Inicia sesión en LinkedIn
- `searchPerson(name)`: Busca personas por nombre
- `getProfileDetails(profileUrl)`: Obtiene detalles completos de un perfil
- `close()`: Cierra el navegador

## Ejemplo de uso programático

```javascript
import LinkedInScraper from './index.js';

const scraper = new LinkedInScraper();
await scraper.init();
await scraper.login('email@ejemplo.com', 'password');

// Buscar personas
const profiles = await scraper.searchPerson('Juan Pérez');

// Obtener detalles de un perfil específico
const details = await scraper.getProfileDetails(profiles[0].urlPerfil);

await scraper.close();
```

## Búsqueda Masiva

La búsqueda masiva permite procesar múltiples nombres automáticamente:

- **Delays automáticos**: Entre búsquedas (configurable) y entre perfiles (2 segundos)
- **Estadísticas**: Muestra progreso y resultados al finalizar
- **Manejo de errores**: Continúa aunque falle alguna búsqueda
- **Límite de perfiles**: Por defecto obtiene hasta 10 perfiles por búsqueda
- **Resultados organizados**: Guarda todos los resultados en un solo archivo JSON con metadata

**Ejemplo de salida de búsqueda masiva:**
```json
{
  "fecha": "2024-01-28T...",
  "estadisticas": {
    "total": 10,
    "completed": 10,
    "failed": 0,
    "profilesFound": 45
  },
  "resultados": [
    {
      "busqueda": "Juan Pérez",
      "fecha": "2024-01-28T...",
      "cantidadPerfiles": 8,
      "perfiles": [...]
    }
  ]
}
```

## Notas

- El navegador se ejecuta en modo visible por defecto (`headless: false`). Puedes cambiarlo a `true` en el método `init()` para ejecutarlo en segundo plano.
- LinkedIn puede requerir verificación CAPTCHA o bloquear cuentas si detecta actividad automatizada.
- **IMPORTANTE**: Para búsquedas masivas, se recomienda usar delays mayores (10-15 segundos) para evitar ser bloqueado.
- Los resultados se guardan automáticamente en archivos JSON con timestamp.
- En búsquedas masivas, el archivo de salida se llama `resultados_masivos_[timestamp].json`

