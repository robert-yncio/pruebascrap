# Ejemplos Prácticos - Exclusiones por URLs Directas

## Casos de uso comunes

### 1. Excluir algunos perfiles específicos rápidamente

```bash
# Buscar "Director de Marketing" excluyendo 2 perfiles específicos
node index.js "Director de Marketing" --exclude="linkedin.com/in/juan-perez,linkedin.com/in/maria-garcia"

# Equivalente usando --exclude-urls
node index.js "Director de Marketing" --exclude-urls="linkedin.com/in/juan-perez,linkedin.com/in/maria-garcia"
```

### 2. Combinar con filtros de keywords

```bash
# Buscar desarrolladores, filtrar por "javascript" y excluir perfiles específicos
node index.js "Desarrollador" --keywords="javascript,react,nodejs" --exclude="linkedin.com/in/dev1,linkedin.com/in/dev2"
```

### 3. Búsqueda masiva excluyendo perfiles conocidos

```bash
# Buscar desde archivo de nombres, excluyendo algunos perfiles directamente
node index.js nombres.json --exclude="linkedin.com/in/usuario1,linkedin.com/in/usuario2,linkedin.com/in/usuario3"
```

### 4. URLs con diferentes formatos (se normalizan automáticamente)

```bash
# Todas estas URLs se normalizan correctamente:
node index.js "CEO" --exclude="https://www.linkedin.com/in/ceo1/?param=1,linkedin.com/in/ceo2/,www.linkedin.com/in/ceo3"
```

## Ventajas de URLs directas vs archivos

### URLs directas ✅
- **Rápido**: No necesitas crear/editar archivos
- **Inmediato**: Perfecto para exclusiones puntuales
- **Visible**: Las URLs están en el comando, fácil de ver qué se excluye
- **Temporal**: Ideal para pruebas o exclusiones de una sola vez

### Archivos ✅
- **Reutilizable**: Mantener listas permanentes de exclusiones
- **Organizado**: Mejor para muchas URLs (>5)
- **Documentado**: Puedes agregar comentarios explicando por qué se excluye
- **Versionado**: Puedes versionar los archivos de exclusión

## Ejemplos paso a paso

### Ejemplo 1: Búsqueda rápida con exclusiones
```bash
# Paso 1: Buscar "Product Manager" sin exclusiones
node index.js "Product Manager" --max=10

# Paso 2: Revisar resultados y identificar perfiles no deseados
# Supongamos que encontramos estos perfiles no relevantes:
# - https://www.linkedin.com/in/junior-pm/
# - https://www.linkedin.com/in/student-pm/

# Paso 3: Repetir búsqueda excluyendo esos perfiles
node index.js "Product Manager" --max=10 --exclude="linkedin.com/in/junior-pm,linkedin.com/in/student-pm"
```

### Ejemplo 2: Refinamiento iterativo
```bash
# Primera búsqueda
node index.js "Data Scientist" --keywords="python,machine learning" --max=15

# Después de revisar, excluir perfiles no deseados y buscar más
node index.js "Data Scientist" --keywords="python,machine learning" --max=15 --exclude="linkedin.com/in/student1,linkedin.com/in/junior1,linkedin.com/in/intern1"

# Continuar refinando si es necesario
node index.js "Data Scientist" --keywords="python,machine learning" --max=20 --exclude="linkedin.com/in/student1,linkedin.com/in/junior1,linkedin.com/in/intern1,linkedin.com/in/bootcamp1"
```

### Ejemplo 3: Combinando métodos
```bash
# Usar archivo para exclusiones permanentes y URLs directas para exclusiones temporales
node index.js "CTO" --exclude-file="ctos_ya_contactados.json" --exclude-urls="linkedin.com/in/cto-temporal1,linkedin.com/in/cto-temporal2"
```

## Tips y mejores prácticas

1. **URLs cortas**: Puedes omitir `https://www.` - se agrega automáticamente
   ```bash
   # Esto:
   --exclude="linkedin.com/in/user1,linkedin.com/in/user2"
   
   # Es equivalente a:
   --exclude="https://www.linkedin.com/in/user1,https://www.linkedin.com/in/user2"
   ```

2. **Sin espacios**: No agregues espacios después de las comas
   ```bash
   # ✅ Correcto:
   --exclude="user1,user2,user3"
   
   # ❌ Incorrecto:
   --exclude="user1, user2, user3"
   ```

3. **Comillas**: Usa comillas para evitar problemas con caracteres especiales
   ```bash
   # ✅ Recomendado:
   --exclude="linkedin.com/in/user1,linkedin.com/in/user-2"
   
   # ⚠️ Puede fallar:
   --exclude=linkedin.com/in/user1,linkedin.com/in/user-2
   ```

4. **Verificación**: El sistema te mostrará qué URLs se procesaron
   ```
   Procesando URLs de exclusión directas...
   ✓ Procesadas 3 URLs de exclusión directas
     1. https://linkedin.com/in/user1
     2. https://linkedin.com/in/user2  
     3. https://linkedin.com/in/user3
   ```

5. **Combinación inteligente**: Para listas grandes usa archivos, para exclusiones puntuales usa URLs directas