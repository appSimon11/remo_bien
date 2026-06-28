# Pool Console MySQL

Dashboard privado para capturar ganancias diarias por pool, detectar resets, consultar estadísticas, forecast e importar/exportar CSV.

Esta versión está preparada para **Railway con MySQL**.

## Usuarios iniciales

| Usuario | Contraseña | Pools iniciales |
| --- | --- | --- |
| Andres | `Andres$` | `rojo`, `negro` |
| Sandra | `Sandra$` | `UNI` |

## Reglas de negocio

- El dato capturado es el acumulado visible del pool.
- Si el acumulado de hoy es menor que el registro anterior del mismo pool, se marca como pool modificado/reset.
- En reset, la ganancia diaria es el valor visible nuevo.
- El acumulado ajustado sigue sumando históricamente. Ejemplo: ayer `100`, hoy `2` => ganancia diaria `2`, acumulado ajustado `102`.
- El promedio semanal se calcula por semana calendario, de lunes a domingo, usando únicamente los días transcurridos.
- El mapa del año marca en rojo los días de `40` o menos, en amarillo los días de `41` a `50`, y en verde los días de `51` o más.
- La vista de captura muestra la probabilidad de cumplir meta usando el historial.
- Cada usuario ve solamente sus propios datos.
- Todos los valores están en dólares.

## Estructura

```txt
remo3/
  public/          Interfaz web
  sql/schema.sql   Esquema MySQL de referencia
  server.js        API, login y conexión MySQL
  package.json     Scripts y dependencias
  .env.example     Variables de entorno ejemplo
```

## Variables para Railway

En el servicio web de la app:

```txt
NODE_ENV=production
SESSION_SECRET=pon-aqui-un-texto-largo-privado
MYSQL_URL=${{ MySQL.MYSQL_URL }}
```

Si tu servicio de MySQL en Railway tiene otro nombre, cambia `MySQL` por el nombre exacto del servicio.

La app también acepta:

```txt
DATABASE_URL=${{ MySQL.MYSQL_URL }}
```

o variables separadas:

```txt
MYSQLHOST=...
MYSQLPORT=3306
MYSQLUSER=...
MYSQLPASSWORD=...
MYSQLDATABASE=...
```

No configures `PORT` en Railway salvo que tengas una razón específica. Railway suele inyectarlo automáticamente.

## Deploy

Railway detecta `package.json` y ejecuta:

```bash
npm install
npm start
```

Al arrancar, la app:

- crea las tablas si no existen
- crea los usuarios `Andres` y `Sandra`
- crea los pools iniciales `rojo`, `negro` y `UNI`

## Desarrollo local

1. Instala Node.js 20 o superior.
2. Crea una base MySQL local.
3. Copia `.env.example` a `.env`.
4. Llena `MYSQL_URL`.
5. Instala dependencias:

```bash
npm install
```

6. Arranca la app:

```bash
npm run dev
```

7. Abre:

```txt
http://localhost:3000
```

## CSV

Para importar datos en batch, puedes usar archivo o pegar el contenido directamente en la cuarta sección.

Formato recomendado:

```csv
date,pool,total
2026-05-23,rojo,1000
2026-05-23,negro,850
```

También acepta:

- columnas `fecha,pool,acumulado`
- separador por coma, punto y coma o tabulador
- fechas `AAAA-MM-DD`, `AAAA/MM/DD`, `DD/MM/AAAA` o `DD-MM-AAAA`
- números con punto o coma decimal

La app previsualiza nuevos registros, reemplazos y errores antes de guardar.
