# Backoffice de básculas de doble plataforma — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poder configurar dos básculas independientes como una báscula lógica de dos plataformas, enlazando una secundaria desde la primaria.

**Architecture:** `scales` gana `secondary_scale_id`. Una regla de validación concentra las cinco condiciones que hacen enlazable a una candidata. `findScale()` deja de elegir arbitrariamente entre las básculas de un puesto y devuelve siempre la primaria. El formulario ofrece el enlace solo al editar, porque la secundaria tiene que existir antes.

**Tech Stack:** Laravel 12, PHP 8.3, PHPUnit, Blade, tema `riho`.

## Global Constraints

- **Repo de trabajo:** `/home/manel/Documentos/verentia`, rama `feature/mettler-scales`. No crear ramas, no hacer merge, no hacer push.
- **`.env.testing` y `composer.lock` están modificados y son del propietario del repo.** Nunca commitearlos. Indexar por ruta explícita; **jamás** `git add -A`, `git add .`, `git add -u` ni `git commit -a`. Comprobar con `git status --short` antes de commitear y con `git show --stat --format="" HEAD` después. Revisar el índice antes de indexar y desindexar lo que no hayas añadido tú.
- **PROHIBIDO** ejecutar `php artisan migrate`, `migrate:fresh`, `db:seed` ni nada que escriba en la base de datos de desarrollo. `RefreshDatabase` gestiona su propio esquema.
- **No tocar `.lerd.yaml` ni los enlaces de sitios.** El entorno ya está montado: `verentia.test` → `/home/manel/Documentos/verentia`.
- **Código y comentarios SIEMPRE en inglés**, incluidos docblocks y nombres de métodos de test. Los valores de `lang/es/*` siguen en español porque son cadenas de cara al usuario.
- Tests: `php artisan test --filter=<Clase>`. Estilo: `./vendor/bin/pint` sobre lo que toques.
- **El tema activo es `riho`.** `config/view.php` fija `'theme' => env('THEME', 'riho')` y `VersionedViewFinder` reescribe `SGA::admin.x` a `SGA::riho.admin.x`. Las vistas planas bajo `admin/scales/` **no se sirven**. Editar las de `riho/`.
- **Plataforma 1 = la pequeña de precisión. Plataforma 2 = la grande de capacidad.** Invertirlo enviaría cada pesada a la báscula equivocada sin producir ningún error.
- Spec: `2026-08-05-dual-platform-scales-design.md` en el repo `02384_SGA_Electron`.
- **El runtime queda FUERA de este plan**: nada de `resolvePlatform()`, ni el payload de `validateScaleSetup()`, ni el navegador. Este plan solo permite configurar el enlace.

## Estado de partida

- `scales`: `id`, `workstation_id`, `name`, `brand` (NOT NULL), `model` (nullable), `protocol_options` (JSON, cast `array`), `ip_address`, `port`, `is_active`, timestamps.
- `Scale::SCALE_BRAND_OPTIONS` = `['mettler_toledo' => 'Mettler Toledo', 'bizerba' => 'Bizerba']`.
- `Scale::SCALE_MODEL_OPTIONS` = modelos agrupados por marca. `Scale::modelsFor(string $brand): array`.
- `app/Modules/SGA/database/factories/ScaleFactory.php` existe.
- Los campos del formulario viven en `riho/admin/scales/_partials/form-content.blade.php`, compartido por create y edit. Recibe `$scale` (null al crear), `$brands` y `$modelsByBrand`. Los scripts van por `@push('custom_scripts')`.
- `workstation_id` es un `select2` que carga por AJAX desde `route('admin.work_station.select2')`.
- Existe `App\Modules\SGA\Rules\ModelBelongsToBrand` como patrón de regla a seguir.

---

### Task 1: Columna, relaciones y scope de primarias

**Files:**
- Create: `app/Modules/SGA/database/migrations/2026_08_05_100000_add_secondary_scale_to_scales_table.php`
- Modify: `app/Modules/SGA/Models/Scale.php`
- Create: `tests/Feature/Modules/SGA/ScaleSecondaryLinkTest.php`

**Interfaces:**
- Consumes: nada.
- Produces:
  - Columna `scales.secondary_scale_id`, nullable, FK a `scales.id` con `nullOnDelete`, índice **único**.
  - `Scale::secondary(): BelongsTo` — la plataforma 2, o `null`.
  - `Scale::primary(): HasOne` — la báscula que enlaza a esta, o `null`.
  - `Scale::isSecondary(): bool`
  - `Scale::scopePrimaries(Builder $query): void` — excluye las que son secundaria de alguien.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleSecondaryLinkTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ScaleSecondaryLinkTest extends TestCase
{
    use RefreshDatabase;

    private function pair(): array
    {
        $workstation = WorkStation::factory()->create();

        $large = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Big scale',
        ]);

        $small = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Small scale',
            'secondary_scale_id' => $large->id,
        ]);

        return [$small, $large, $workstation];
    }

    public function test_the_scales_table_gains_the_secondary_column(): void
    {
        $this->assertTrue(Schema::hasColumn('scales', 'secondary_scale_id'));
    }

    public function test_a_scale_with_no_link_has_no_secondary(): void
    {
        $scale = Scale::factory()->create();

        $this->assertNull($scale->secondary_scale_id);
        $this->assertNull($scale->secondary);
        $this->assertFalse($scale->isSecondary());
    }

    public function test_the_primary_reaches_its_secondary(): void
    {
        [$small, $large] = $this->pair();

        $this->assertSame($large->id, $small->secondary->id);
        $this->assertFalse($small->isSecondary());
    }

    public function test_the_secondary_knows_its_primary(): void
    {
        [$small, $large] = $this->pair();

        $this->assertSame($small->id, $large->primary->id);
        $this->assertTrue($large->isSecondary());
    }

    public function test_the_primaries_scope_excludes_linked_secondaries(): void
    {
        [$small, $large, $workstation] = $this->pair();

        $ids = Scale::primaries()->where('workstation_id', $workstation->id)->pluck('id');

        $this->assertTrue($ids->contains($small->id));
        $this->assertFalse($ids->contains($large->id), 'the secondary must not be listed as a primary');
    }

    public function test_deleting_the_secondary_clears_the_link_instead_of_deleting_the_primary(): void
    {
        [$small, $large] = $this->pair();

        $large->delete();

        $this->assertNotNull($small->fresh(), 'the primary must survive');
        $this->assertNull($small->fresh()->secondary_scale_id);
    }

    public function test_two_primaries_cannot_claim_the_same_secondary(): void
    {
        [$small, $large, $workstation] = $this->pair();

        $this->expectException(\Illuminate\Database\QueryException::class);

        Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Another primary',
            'secondary_scale_id' => $large->id,
        ]);
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleSecondaryLinkTest`
Expected: FAIL — `Schema::hasColumn('scales', 'secondary_scale_id')` devuelve false.

- [ ] **Step 3: Escribir la migración**

```php
<?php
// app/Modules/SGA/database/migrations/2026_08_05_100000_add_secondary_scale_to_scales_table.php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Platform 2 of a logical scale. When it is set, platform 2 lives on another
     * device and is reached by talking to its IP; when it is null, platform 2 is a
     * command to this same device. That single precedence rule covers both brands.
     *
     * The unique index is what stops two primaries claiming the same secondary,
     * which would make one of the two setups silently weigh on the wrong scale.
     */
    public function up(): void
    {
        Schema::table('scales', function (Blueprint $table) {
            $table->foreignId('secondary_scale_id')
                ->nullable()
                ->after('model')
                ->constrained('scales')
                ->nullOnDelete();

            $table->unique('secondary_scale_id');
        });
    }

    public function down(): void
    {
        Schema::table('scales', function (Blueprint $table) {
            $table->dropUnique(['secondary_scale_id']);
            $table->dropConstrainedForeignId('secondary_scale_id');
        });
    }
};
```

- [ ] **Step 4: Actualizar el modelo**

En `app/Modules/SGA/Models/Scale.php`:

Añadir los `use` que faltan junto a los existentes:

```php
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\HasOne;
```

Añadir `'secondary_scale_id'` a `$fillable`, justo después de `'model'`.

Añadir al final de la clase:

```php
    /**
     * Platform 2 when it lives on a separate device.
     *
     * Null means platform 2 is a command to this same device, which is how the
     * Bizerba terminals work. See the precedence rule in the design spec.
     */
    public function secondary(): BelongsTo
    {
        return $this->belongsTo(self::class, 'secondary_scale_id');
    }

    /** The scale that uses this one as its platform 2, if any. */
    public function primary(): HasOne
    {
        return $this->hasOne(self::class, 'secondary_scale_id');
    }

    public function isSecondary(): bool
    {
        return $this->primary()->exists();
    }

    /**
     * Only scales that are not somebody else's platform 2.
     *
     * findScale() resolves one scale per workstation, so without this a
     * workstation holding a linked pair would return whichever row had the higher
     * id — arbitrarily, and half the time the wrong one.
     */
    public function scopePrimaries(Builder $query): void
    {
        $query->whereNotExists(function ($sub) {
            $sub->selectRaw('1')
                ->from('scales as linking_scale')
                ->whereColumn('linking_scale.secondary_scale_id', 'scales.id');
        });
    }
```

- [ ] **Step 5: Traducir al inglés los comentarios en español del modelo**

`Scale.php` lleva dos docblocks en español sobre `SCALE_BRAND_OPTIONS` y `SCALE_MODEL_OPTIONS`, escritos antes de que se fijara la regla de idioma. Tradúcelos conservando el razonamiento, que es lo que les da valor: que las claves de marca coinciden **exactamente** con los ids de driver de VerentiaIP para no necesitar traducción entre repos, y que el catálogo de modelos es a propósito más amplio que la tabla de overrides de VerentiaIP, así que un modelo sin override allí es el caso normal y no un error. No cambies los valores de las constantes.

- [ ] **Step 6: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleSecondaryLinkTest`
Expected: PASS, 7 tests.

Si el test del índice único falla porque la excepción llega envuelta, ajusta la clase esperada a la que realmente lance tu driver de base de datos, y dilo en el informe — no relajes el test a `expectException(\Exception::class)`.

- [ ] **Step 7: Sin regresión**

Run: `php artisan test --filter="ScaleBrandMigration|ScaleForm|ScaleGateway|ScaleWeightParser"`
Expected: todo verde. Anota los números reales.

- [ ] **Step 8: Estilo y commit**

```bash
# Pint por FICHERO, nunca por directorio: apuntar a un directorio de migraciones
# reformatea decenas de ficheros ajenos preexistentes.
./vendor/bin/pint app/Modules/SGA/Models/Scale.php app/Modules/SGA/database/migrations/2026_08_05_100000_add_secondary_scale_to_scales_table.php
git status --short
git add app/Modules/SGA/database/migrations/2026_08_05_100000_add_secondary_scale_to_scales_table.php app/Modules/SGA/Models/Scale.php tests/Feature/Modules/SGA/ScaleSecondaryLinkTest.php
git commit -m "feat(sga): link a secondary scale as platform 2

A configured secondary means platform 2 is that other device; null means
platform 2 is a command to this same device. One precedence rule covers
both brands without the SGA knowing the driver catalogue.

The unique index stops two primaries claiming the same secondary, which
would leave one setup silently weighing on the wrong scale. The primaries
scope is what keeps findScale() from picking a linked secondary."
git show --stat --format="" HEAD
```

---

### Task 2: La regla de enlace

Cinco condiciones en un solo sitio. Sin ellas se configura mal en silencio, y una báscula mal enlazada no da error: da pesos de la báscula equivocada.

**Files:**
- Create: `app/Modules/SGA/Rules/SecondaryScaleIsLinkable.php`
- Modify: `app/Modules/SGA/Http/Requests/Scale/StoreRequest.php`
- Modify: `app/Modules/SGA/Http/Requests/Scale/UpdateRequest.php`
- Modify: `app/Modules/SGA/UseCases/Scale/StoreUseCase.php`
- Modify: `app/Modules/SGA/UseCases/Scale/UpdateUseCase.php`
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` (`store()` y `update()`)
- Modify: `app/Modules/SGA/lang/es/messages.php`, `app/Modules/SGA/lang/en/messages.php`
- Create: `tests/Feature/Modules/SGA/ScaleSecondaryValidationTest.php`

**Interfaces:**
- Consumes: `Scale::isSecondary()` de Task 1.
- Produces:
  - `SecondaryScaleIsLinkable(?string $brand, ?int $workstationId, ?int $selfId)` — regla de validación.
  - `StoreUseCase::__construct(..., ?int $secondary_scale_id)` y lo mismo en `UpdateUseCase`.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleSecondaryValidationTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Models\Role;
use App\Models\User;
use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ScaleSecondaryValidationTest extends TestCase
{
    use RefreshDatabase;

    protected User $user;
    protected WorkStation $workstation;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();

        $this->user = User::factory()->create();
        $role = Role::where('title', 'Admin')->first();
        if ($role) {
            $this->user->roles()->sync([$role->id]);
        }
        $this->actingAs($this->user);

        $this->workstation = WorkStation::factory()->create();
    }

    private function scale(array $overrides = []): Scale
    {
        return Scale::factory()->create(array_merge([
            'workstation_id' => $this->workstation->id,
            'brand' => 'mettler_toledo',
        ], $overrides));
    }

    private function update(Scale $scale, array $overrides = []): \Illuminate\Testing\TestResponse
    {
        return $this->put(route('admin.scales.update', $scale), array_merge([
            'name' => $scale->name,
            'brand' => $scale->brand,
            'model' => '',
            'ip_address' => $scale->ip_address,
            'port' => $scale->port,
            'workstation_id' => $scale->workstation_id,
            'is_active' => '1',
        ], $overrides));
    }

    public function test_it_links_a_valid_secondary(): void
    {
        $small = $this->scale(['name' => 'Small']);
        $large = $this->scale(['name' => 'Large']);

        $this->update($small, ['secondary_scale_id' => $large->id])
            ->assertSessionHasNoErrors();

        $this->assertSame($large->id, $small->fresh()->secondary_scale_id);
    }

    public function test_an_empty_secondary_is_valid_and_means_platform_2_by_command(): void
    {
        $small = $this->scale();

        $this->update($small, ['secondary_scale_id' => ''])->assertSessionHasNoErrors();

        $this->assertNull($small->fresh()->secondary_scale_id);
    }

    public function test_a_scale_cannot_be_its_own_secondary(): void
    {
        $scale = $this->scale();

        $this->update($scale, ['secondary_scale_id' => $scale->id])
            ->assertSessionHasErrors('secondary_scale_id');
    }

    public function test_the_secondary_must_share_the_brand(): void
    {
        $small = $this->scale(['brand' => 'mettler_toledo', 'name' => 'Small']);
        $other = $this->scale(['brand' => 'bizerba', 'name' => 'A Bizerba']);

        $this->update($small, ['secondary_scale_id' => $other->id])
            ->assertSessionHasErrors('secondary_scale_id');
    }

    public function test_the_secondary_must_share_the_workstation(): void
    {
        $small = $this->scale(['name' => 'Small']);
        $elsewhere = Scale::factory()->create([
            'workstation_id' => WorkStation::factory()->create()->id,
            'brand' => 'mettler_toledo',
            'name' => 'Far away',
        ]);

        $this->update($small, ['secondary_scale_id' => $elsewhere->id])
            ->assertSessionHasErrors('secondary_scale_id');
    }

    public function test_a_secondary_already_linked_elsewhere_is_rejected(): void
    {
        $large = $this->scale(['name' => 'Large']);
        $this->scale(['name' => 'First primary', 'secondary_scale_id' => $large->id]);
        $another = $this->scale(['name' => 'Second primary']);

        $this->update($another, ['secondary_scale_id' => $large->id])
            ->assertSessionHasErrors('secondary_scale_id');
    }

    public function test_a_scale_that_already_has_a_secondary_cannot_itself_be_one(): void
    {
        $large = $this->scale(['name' => 'Large']);
        $middle = $this->scale(['name' => 'Middle', 'secondary_scale_id' => $large->id]);
        $top = $this->scale(['name' => 'Top']);

        // Linking `middle` under `top` would make a chain top -> middle -> large.
        $this->update($top, ['secondary_scale_id' => $middle->id])
            ->assertSessionHasErrors('secondary_scale_id');
    }

    public function test_a_nonexistent_secondary_is_rejected(): void
    {
        $scale = $this->scale();

        $this->update($scale, ['secondary_scale_id' => 999999])
            ->assertSessionHasErrors('secondary_scale_id');
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleSecondaryValidationTest`
Expected: FAIL — `secondary_scale_id` no se valida ni se guarda todavía.

- [ ] **Step 3: Escribir la regla**

```php
<?php
// app/Modules/SGA/Rules/SecondaryScaleIsLinkable.php

declare(strict_types=1);

namespace App\Modules\SGA\Rules;

use App\Modules\SGA\Models\Scale;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * A scale may only be linked as platform 2 when the pairing describes a real
 * bench: same workstation, same brand, not itself, not already claimed, and not
 * a primary in its own right.
 *
 * These are gathered in one rule rather than spread across several because a
 * wrong link does not fail loudly — it weighs on the wrong scale and the number
 * looks perfectly good.
 */
class SecondaryScaleIsLinkable implements ValidationRule
{
    public function __construct(
        private readonly ?string $brand,
        private readonly ?int $workstationId,
        private readonly ?int $selfId,
    ) {
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if ($value === null || $value === '') {
            return; // Empty means platform 2 is a command to this same device.
        }

        $candidateId = (int) $value;

        if ($this->selfId !== null && $candidateId === $this->selfId) {
            $fail(__('SGA::messages.scale.secondary_is_self'));

            return;
        }

        $candidate = Scale::find($candidateId);

        if ($candidate === null) {
            $fail(__('SGA::messages.scale.secondary_not_found'));

            return;
        }

        if ($this->brand !== null && $candidate->brand !== $this->brand) {
            $fail(__('SGA::messages.scale.secondary_brand_mismatch'));

            return;
        }

        if ($this->workstationId !== null && $candidate->workstation_id !== $this->workstationId) {
            $fail(__('SGA::messages.scale.secondary_workstation_mismatch'));

            return;
        }

        $claimedBy = $candidate->primary;

        if ($claimedBy !== null && $claimedBy->id !== $this->selfId) {
            $fail(__('SGA::messages.scale.secondary_already_linked', ['name' => $claimedBy->name]));

            return;
        }

        if ($candidate->secondary_scale_id !== null) {
            $fail(__('SGA::messages.scale.secondary_has_its_own'));
        }
    }
}
```

- [ ] **Step 4: Añadir los mensajes**

En `app/Modules/SGA/lang/es/messages.php`, dentro del array `'scale'`:

```php
        'secondary_is_self' => 'Una báscula no puede ser su propia plataforma 2',
        'secondary_not_found' => 'La báscula secundaria seleccionada no existe',
        'secondary_brand_mismatch' => 'La báscula secundaria debe ser de la misma marca',
        'secondary_workstation_mismatch' => 'La báscula secundaria debe estar en el mismo puesto de trabajo',
        'secondary_already_linked' => 'Esa báscula ya es la plataforma 2 de :name',
        'secondary_has_its_own' => 'Esa báscula ya tiene su propia plataforma 2, y no se admiten cadenas',
```

En `app/Modules/SGA/lang/en/messages.php`, dentro del array `'scale'`:

```php
        'secondary_is_self' => 'A scale cannot be its own platform 2',
        'secondary_not_found' => 'The selected secondary scale does not exist',
        'secondary_brand_mismatch' => 'The secondary scale must be the same brand',
        'secondary_workstation_mismatch' => 'The secondary scale must be on the same workstation',
        'secondary_already_linked' => 'That scale is already platform 2 of :name',
        'secondary_has_its_own' => 'That scale already has its own platform 2, and chains are not supported',
```

- [ ] **Step 5: Enchufar la regla en los dos requests**

En `StoreRequest::rules()` y `UpdateRequest::rules()`, añadir al array devuelto:

```php
            'secondary_scale_id' => [
                'nullable',
                'integer',
                new SecondaryScaleIsLinkable(
                    $this->input('brand'),
                    $this->input('workstation_id') !== null ? (int) $this->input('workstation_id') : null,
                    $this->route('scale')?->id,
                ),
            ],
```

Y el `use` en cada fichero:

```php
use App\Modules\SGA\Rules\SecondaryScaleIsLinkable;
```

En `StoreRequest` el `$this->route('scale')` es `null`, que es correcto: al crear no hay id propio contra el que comparar.

- [ ] **Step 6: Pasar el valor a los casos de uso**

En `StoreUseCase`, añadir el parámetro al constructor después de `$model` y al array de `Scale::create`:

```php
        protected ?int $secondary_scale_id,
```
```php
            'secondary_scale_id' => $this->secondary_scale_id,
```

Lo mismo en `UpdateUseCase`.

En `ScaleController::store()` y `update()`, pasar el argumento nombrado, normalizando el vacío a `null` igual que ya se hace con `model`:

```php
            secondary_scale_id: $validated['secondary_scale_id'] ?? null,
```

- [ ] **Step 7: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleSecondaryValidationTest`
Expected: PASS, 8 tests.

- [ ] **Step 8: Sin regresión**

Run: `php artisan test --filter="ScaleSecondaryLink|ScaleBrandMigration|ScaleForm|ScaleGateway|ScaleWeightParser"`
Expected: todo verde, números reales en el informe.

- [ ] **Step 9: Estilo y commit**

```bash
# Pint por FICHERO, nunca por directorio: un directorio arrastra ficheros ajenos.
./vendor/bin/pint app/Modules/SGA/Rules/SecondaryScaleIsLinkable.php app/Modules/SGA/Http/Requests/Scale/StoreRequest.php app/Modules/SGA/Http/Requests/Scale/UpdateRequest.php app/Modules/SGA/UseCases/Scale/StoreUseCase.php app/Modules/SGA/UseCases/Scale/UpdateUseCase.php app/Modules/SGA/Http/Controllers/Admin/ScaleController.php
git status --short
git add app/Modules/SGA/Rules/SecondaryScaleIsLinkable.php app/Modules/SGA/Http/Requests/Scale/StoreRequest.php app/Modules/SGA/Http/Requests/Scale/UpdateRequest.php app/Modules/SGA/UseCases/Scale/StoreUseCase.php app/Modules/SGA/UseCases/Scale/UpdateUseCase.php app/Modules/SGA/Http/Controllers/Admin/ScaleController.php app/Modules/SGA/lang/es/messages.php app/Modules/SGA/lang/en/messages.php tests/Feature/Modules/SGA/ScaleSecondaryValidationTest.php
git commit -m "feat(sga): validate that a secondary scale is linkable

Five conditions in one rule: same workstation, same brand, not itself,
not already claimed by another primary, and not a primary in its own
right. They live together because a wrong link does not fail loudly — it
weighs on the wrong scale and the number looks perfectly good.

Each condition has its own message, so a misconfiguration says which
thing is wrong instead of just refusing."
git show --stat --format="" HEAD
```

---

### Task 3: `findScale()` deja de elegir arbitrariamente

Este es un bug preexistente que la columna nueva hace alcanzable: en cuanto un puesto tiene dos básculas, `orderByDesc('id')->first()` devuelve la de id más alto, o sea la grande la mitad de las veces.

**Files:**
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` (`findScale()`)
- Create: `tests/Feature/Modules/SGA/ScaleFindScaleTest.php`

**Interfaces:**
- Consumes: `Scale::scopePrimaries()` de Task 1.
- Produces: nada nuevo. `findScale()` mantiene su firma `?Scale`.

- [ ] **Step 1: Escribir el test que falla**

`findScale()` es privado y resuelve el puesto por la IP que devuelve `GET /ip` del escritorio, así que el test lo ejercita por su único consumidor público con ruta, `testConnection`, no: ese recibe la báscula por parámetro. Se prueba por reflexión, que es lo honesto aquí — la alternativa sería exponer el método solo para el test.

```php
<?php
// tests/Feature/Modules/SGA/ScaleFindScaleTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Http\Controllers\Admin\ScaleController;
use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use ReflectionMethod;
use Tests\TestCase;

class ScaleFindScaleTest extends TestCase
{
    use RefreshDatabase;

    private const DESKTOP = 'http://localhost:3000';
    private const STATION_IP = '10.0.0.42';

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('sga.desktop_app_service', self::DESKTOP);

        Http::fake([
            self::DESKTOP . '/ip' => Http::response(['ip' => self::STATION_IP]),
        ]);
    }

    private function findScale(): ?Scale
    {
        $method = new ReflectionMethod(ScaleController::class, 'findScale');
        $method->setAccessible(true);

        return $method->invoke(new ScaleController());
    }

    public function test_it_returns_the_primary_and_not_the_higher_id_secondary(): void
    {
        $workstation = WorkStation::factory()->create(['ip_address' => self::STATION_IP]);

        // The large scale is created first so the small one — the primary — has the
        // HIGHER id here. The next test covers the opposite order, which is the one
        // the old orderByDesc('id') got wrong.
        $large = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Large',
        ]);
        $small = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Small',
            'secondary_scale_id' => $large->id,
        ]);

        $this->assertSame($small->id, $this->findScale()?->id);
    }

    public function test_it_returns_the_primary_even_when_the_secondary_has_the_higher_id(): void
    {
        $workstation = WorkStation::factory()->create(['ip_address' => self::STATION_IP]);

        $small = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Small',
        ]);
        $large = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'name' => 'Large',
        ]);
        $small->update(['secondary_scale_id' => $large->id]);

        // This is the case the old implementation got wrong: the secondary has the
        // higher id, so orderByDesc('id') returned the large scale.
        $this->assertSame($small->id, $this->findScale()?->id);
    }

    public function test_a_single_unlinked_scale_still_resolves(): void
    {
        $workstation = WorkStation::factory()->create(['ip_address' => self::STATION_IP]);
        $only = Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'bizerba',
        ]);

        $this->assertSame($only->id, $this->findScale()?->id);
    }

    public function test_a_workstation_with_no_scales_resolves_to_null(): void
    {
        WorkStation::factory()->create(['ip_address' => self::STATION_IP]);

        $this->assertNull($this->findScale());
    }

    public function test_an_unknown_station_ip_resolves_to_null(): void
    {
        WorkStation::factory()->create(['ip_address' => '10.0.0.99']);
        Scale::factory()->create(['brand' => 'bizerba']);

        $this->assertNull($this->findScale());
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleFindScaleTest`
Expected: FAIL en `test_it_returns_the_primary_even_when_the_secondary_has_the_higher_id`, que devuelve la báscula grande. Ese fallo concreto **es la prueba de que el bug existe**: apúntalo en el informe antes de arreglarlo.

- [ ] **Step 3: Arreglar `findScale()`**

En `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php`, sustituir el cuerpo:

```php
    /**
     * The scale for the workstation this request comes from.
     *
     * Restricted to primaries: a workstation with a linked pair holds two rows,
     * and the secondary is platform 2, reachable only through its primary. Without
     * the scope this returned whichever row had the higher id, which is the wrong
     * one half the time and gives no sign that anything went wrong.
     */
    private function findScale(): ?Scale
    {
        $ip = $this->getLocalIpFromElectron();

        if (!$ip) {
            return null;
        }

        $workstation = WorkStation::where('ip_address', $ip)->first();

        return $workstation?->scales()->primaries()->orderByDesc('id')->first();
    }
```

Se conserva el `orderByDesc('id')` porque sigue haciendo falta un desempate determinista si alguien diera de alta dos primarias sin enlazar en el mismo puesto. Lo que cambia es que ya no puede devolver una secundaria.

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleFindScaleTest`
Expected: PASS, 5 tests.

- [ ] **Step 5: Comprobar que el arreglo muerde**

Quita temporalmente `->primaries()` y confirma que `test_it_returns_the_primary_even_when_the_secondary_has_the_higher_id` vuelve a fallar. Restaura y verifica con `git diff` que el fichero queda igual. Informa de las dos salidas.

- [ ] **Step 6: Sin regresión y commit**

```bash
php artisan test --filter="ScaleSecondaryLink|ScaleSecondaryValidation|ScaleBrandMigration|ScaleForm|ScaleGateway|ScaleWeightParser"
./vendor/bin/pint app/Modules/SGA/Http/Controllers/Admin/ScaleController.php
git status --short
git add app/Modules/SGA/Http/Controllers/Admin/ScaleController.php tests/Feature/Modules/SGA/ScaleFindScaleTest.php
git commit -m "fix(sga): findScale must not return a linked secondary

A workstation with a linked pair holds two rows, and orderByDesc('id')
returned whichever had the higher id — the large scale half the time,
with nothing to indicate the wrong one had been chosen. The secondary is
platform 2 and is reachable only through its primary.

The ordering stays as a deterministic tie-break for a workstation holding
two unlinked primaries."
git show --stat --format="" HEAD
```

---

### Task 4: El select de secundaria en el formulario

**Files:**
- Modify: `app/Modules/SGA/resources/views/riho/admin/scales/_partials/form-content.blade.php`
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` (`edit()`)
- Modify: `app/Modules/SGA/lang/es/cruds/scale.php`, `app/Modules/SGA/lang/en/cruds/scale.php`
- Create: `tests/Feature/Modules/SGA/ScaleSecondaryFormTest.php`

**Interfaces:**
- Consumes: `Scale::scopePrimaries()`, `Scale::secondary()` y `Scale::primary()` de Task 1.
- Produces: la vista recibe `$secondaryCandidates` (una `Collection` de `Scale`, vacía al crear) y `$linkedPrimary` (`?Scale`).

**Por qué solo al editar:** la secundaria tiene que existir antes de poder enlazarla, y las candidatas dependen del puesto y de la marca — ambos elegibles en el propio formulario, con `workstation_id` cargando por AJAX. Ofrecer el select al crear obligaría a un endpoint de candidatas que se recalcule con cada cambio, para un caso que no existe: nadie crea la primaria y la secundaria a la vez. Al crear, el select sale deshabilitado explicando que primero hay que guardar.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleSecondaryFormTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Models\Role;
use App\Models\User;
use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ScaleSecondaryFormTest extends TestCase
{
    use RefreshDatabase;

    protected User $user;
    protected WorkStation $workstation;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();

        $this->user = User::factory()->create();
        $role = Role::where('title', 'Admin')->first();
        if ($role) {
            $this->user->roles()->sync([$role->id]);
        }
        $this->actingAs($this->user);

        $this->workstation = WorkStation::factory()->create();
    }

    private function scale(array $overrides = []): Scale
    {
        return Scale::factory()->create(array_merge([
            'workstation_id' => $this->workstation->id,
            'brand' => 'mettler_toledo',
        ], $overrides));
    }

    public function test_the_create_form_does_not_offer_linking(): void
    {
        $this->get(route('admin.scales.create'))
            ->assertOk()
            ->assertSee('secondary_scale_id')
            ->assertSee(trans('SGA::cruds/scale.fields.secondary_create_first'));
    }

    public function test_the_edit_form_offers_a_same_brand_same_station_candidate(): void
    {
        $small = $this->scale(['name' => 'Small one']);
        $large = $this->scale(['name' => 'Large one']);

        $this->get(route('admin.scales.edit', $small))
            ->assertOk()
            ->assertSee('Large one');
    }

    public function test_it_does_not_offer_a_different_brand(): void
    {
        $small = $this->scale(['name' => 'Small one', 'brand' => 'mettler_toledo']);
        $this->scale(['name' => 'A Bizerba here', 'brand' => 'bizerba']);

        $this->get(route('admin.scales.edit', $small))
            ->assertOk()
            ->assertDontSee('A Bizerba here');
    }

    public function test_it_does_not_offer_a_scale_from_another_workstation(): void
    {
        $small = $this->scale(['name' => 'Small one']);
        Scale::factory()->create([
            'workstation_id' => WorkStation::factory()->create()->id,
            'brand' => 'mettler_toledo',
            'name' => 'Somewhere else',
        ]);

        $this->get(route('admin.scales.edit', $small))
            ->assertOk()
            ->assertDontSee('Somewhere else');
    }

    public function test_it_does_not_offer_a_scale_already_linked_by_another_primary(): void
    {
        $large = $this->scale(['name' => 'Taken large']);
        $this->scale(['name' => 'Owner', 'secondary_scale_id' => $large->id]);
        $candidate = $this->scale(['name' => 'Looking for one']);

        $this->get(route('admin.scales.edit', $candidate))
            ->assertOk()
            ->assertDontSee('Taken large');
    }

    public function test_it_does_not_offer_itself(): void
    {
        $scale = $this->scale(['name' => 'Only me here']);

        // Asserted on the view data rather than the HTML: the scale's own name also
        // appears in the name field, and the workstation select2 renders its own
        // <option value="N"> whose id could collide with this scale's by chance.
        $this->get(route('admin.scales.edit', $scale))
            ->assertOk()
            ->assertViewHas('secondaryCandidates', function ($candidates) use ($scale) {
                return !$candidates->contains('id', $scale->id);
            });
    }

    public function test_editing_a_secondary_says_whose_platform_2_it_is(): void
    {
        $large = $this->scale(['name' => 'Large one']);
        $small = $this->scale(['name' => 'Small one', 'secondary_scale_id' => $large->id]);

        $this->get(route('admin.scales.edit', $large))
            ->assertOk()
            ->assertSee('Small one')
            ->assertSee(trans('SGA::cruds/scale.fields.secondary_is_linked', ['name' => 'Small one']));
    }

    public function test_the_currently_linked_secondary_stays_selected(): void
    {
        $large = $this->scale(['name' => 'Large one']);
        $small = $this->scale(['name' => 'Small one', 'secondary_scale_id' => $large->id]);

        $this->get(route('admin.scales.edit', $small))
            ->assertOk()
            ->assertSee('<option value="' . $large->id . '" selected', escape: false);
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleSecondaryFormTest`
Expected: FAIL — la vista no tiene el campo ni las claves de idioma existen.

- [ ] **Step 3: Añadir las claves de idioma**

En `app/Modules/SGA/lang/es/cruds/scale.php`, dentro de `'fields'`:

```php
        'secondary' => 'Báscula secundaria (plataforma 2)',
        'secondary_none' => 'Ninguna: plataforma 2 por comando',
        'secondary_helper' => 'La plataforma 1 es la báscula pequeña de precisión y la 2 la grande de capacidad. Enlaza aquí la grande solo si es un equipo aparte con su propia IP.',
        'secondary_create_first' => 'Guarda primero la báscula para poder enlazarle una secundaria',
        'secondary_no_candidates' => 'No hay ninguna báscula del mismo puesto y marca disponible para enlazar',
        'secondary_is_linked' => 'Esta báscula es la plataforma 2 de :name, así que no se le puede enlazar otra',
```

En `app/Modules/SGA/lang/en/cruds/scale.php`, dentro de `'fields'`:

```php
        'secondary' => 'Secondary scale (platform 2)',
        'secondary_none' => 'None: platform 2 by command',
        'secondary_helper' => 'Platform 1 is the small precision scale and platform 2 the large capacity one. Link the large one here only when it is a separate device with its own IP.',
        'secondary_create_first' => 'Save the scale first to be able to link a secondary',
        'secondary_no_candidates' => 'No scale on the same workstation and brand is available to link',
        'secondary_is_linked' => 'This scale is platform 2 of :name, so it cannot have one of its own',
```

- [ ] **Step 4: Pasar candidatas y primaria a la vista**

En `ScaleController::edit()`, sustituir el cuerpo por:

```php
    public function edit(Scale $scale): View
    {
        $workstations = WorkStation::pluck('name', 'id');
        $brands = Scale::SCALE_BRAND_OPTIONS;
        $modelsByBrand = Scale::SCALE_MODEL_OPTIONS;

        // Candidates for platform 2: same workstation, same brand, not this scale,
        // not already claimed by another primary, and not a primary itself — the
        // same five conditions SecondaryScaleIsLinkable enforces. Offering only
        // valid options keeps the validation a safety net rather than the normal
        // way of discovering a mistake.
        $secondaryCandidates = Scale::query()
            ->where('workstation_id', $scale->workstation_id)
            ->where('brand', $scale->brand)
            ->whereKeyNot($scale->getKey())
            ->whereNull('secondary_scale_id')
            ->primaries()
            ->orderBy('name')
            ->get();

        // If this scale already has one, it must stay in the list so the select can
        // show it as selected — primaries() excludes it by definition.
        if ($scale->secondary !== null) {
            $secondaryCandidates = $secondaryCandidates
                ->push($scale->secondary)
                ->unique('id')
                ->sortBy('name')
                ->values();
        }

        $linkedPrimary = $scale->primary;

        return view('SGA::admin.scales.edit', compact(
            'scale', 'workstations', 'brands', 'modelsByBrand', 'secondaryCandidates', 'linkedPrimary'
        ));
    }
```

Y `create()` pasa las dos variables vacías para que el partial compartido no reviente. Su cuerpo completo queda:

```php
    public function create(): View
    {
        $workstations = WorkStation::pluck('name', 'id');
        $brands = Scale::SCALE_BRAND_OPTIONS;
        $modelsByBrand = Scale::SCALE_MODEL_OPTIONS;
        $secondaryCandidates = collect();
        $linkedPrimary = null;

        return view('SGA::admin.scales.create', compact(
            'workstations', 'brands', 'modelsByBrand', 'secondaryCandidates', 'linkedPrimary'
        ));
    }
```

- [ ] **Step 5: Añadir el campo al partial compartido**

En `riho/admin/scales/_partials/form-content.blade.php`, tras el bloque de `model`, insertar:

```blade
    <div class="form-group col-12 col-md-6 mb-3">
        <label for="secondary_scale_id">{{ trans('SGA::cruds/scale.fields.secondary') }}</label>

        @if ($linkedPrimary)
            <input type="text" class="form-control" disabled
                   value="{{ trans('SGA::cruds/scale.fields.secondary_is_linked', ['name' => $linkedPrimary->name]) }}"/>
        @elseif (!$scale)
            <select class="form-control" id="secondary_scale_id" name="secondary_scale_id" disabled>
                <option value="">{{ trans('SGA::cruds/scale.fields.secondary_create_first') }}</option>
            </select>
        @else
            <select class="form-control {{ $errors->has('secondary_scale_id') ? 'is-invalid' : '' }}"
                    id="secondary_scale_id" name="secondary_scale_id"
                    {{ $secondaryCandidates->isEmpty() ? 'disabled' : '' }}>
                <option value="">
                    {{ $secondaryCandidates->isEmpty()
                        ? trans('SGA::cruds/scale.fields.secondary_no_candidates')
                        : trans('SGA::cruds/scale.fields.secondary_none') }}
                </option>
                @foreach ($secondaryCandidates as $candidate)
                    <option value="{{ $candidate->id }}"
                        {{ (int) old('secondary_scale_id', $scale->secondary_scale_id) === $candidate->id ? 'selected' : '' }}>
                        {{ $candidate->name }}
                    </option>
                @endforeach
            </select>
        @endif

        @if ($errors->has('secondary_scale_id'))
            <span class="text-danger">{{ $errors->first('secondary_scale_id') }}</span>
        @endif
        <span class="help-block text-muted small">{{ trans('SGA::cruds/scale.fields.secondary_helper') }}</span>
    </div>
```

El `disabled` del caso "es secundaria" es deliberado: un campo deshabilitado no se envía, así que quien edite la báscula grande no puede enlazarle nada por accidente ni borrarse su propio enlace desde el lado equivocado.

- [ ] **Step 6: Mantener sincronizadas las vistas clásicas**

Las vistas planas bajo `admin/scales/` están inertes con el tema `riho`, pero se conservan sincronizadas como red del view finder. Añade el mismo bloque a `admin/scales/create.blade.php` y `admin/scales/edit.blade.php`. No inviertas tiempo más allá de copiarlo.

- [ ] **Step 7: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleSecondaryFormTest`
Expected: PASS, 8 tests.

- [ ] **Step 8: Comprobación manual en el navegador**

Abre `/admin/scales`, crea dos básculas Mettler en el mismo puesto ("Pequeña" y "Grande"), edita la Pequeña y confirma que el select ofrece "Grande". Enlázalas. Vuelve a editar la Pequeña: "Grande" debe salir seleccionada. Edita la Grande: debe decir que es la plataforma 2 de Pequeña y no ofrecer select. Crea una tercera Mettler y comprueba que ya no se le ofrece "Grande". Informa de lo que veas.

- [ ] **Step 9: Sin regresión y commit**

```bash
php artisan test --filter="ScaleSecondary|ScaleFindScale|ScaleBrandMigration|ScaleForm|ScaleGateway|ScaleWeightParser"
./vendor/bin/pint app/Modules/SGA/Http/Controllers/Admin/ScaleController.php
git status --short
git add app/Modules/SGA/resources/views/riho/admin/scales/_partials/form-content.blade.php app/Modules/SGA/resources/views/admin/scales/create.blade.php app/Modules/SGA/resources/views/admin/scales/edit.blade.php app/Modules/SGA/Http/Controllers/Admin/ScaleController.php app/Modules/SGA/lang/es/cruds/scale.php app/Modules/SGA/lang/en/cruds/scale.php tests/Feature/Modules/SGA/ScaleSecondaryFormTest.php
git commit -m "feat(sga): offer the platform 2 link in the scale form

Linking is offered on edit only: the secondary has to exist first, and the
candidates depend on the workstation and brand, both editable in the form
with the workstation loading over AJAX. Nobody creates a pair in one go.

The select offers only valid candidates, so the validation rule stays a
safety net rather than the normal way of finding out you got it wrong.
Editing a secondary says whose platform 2 it is instead of leaving the
field mysteriously refusing input."
git show --stat --format="" HEAD
```

---

## Verificación final del plan

- [ ] `php artisan test --filter="Scale"` pasa entero. Anota el total real.
- [ ] `./vendor/bin/pint --test app/Modules/SGA` no reporta cambios pendientes.
- [ ] `git log --oneline` muestra cuatro commits nuevos y ninguno incluye `.env.testing` ni `composer.lock`.
- [ ] Con una sola báscula sin enlazar, el flujo de trasvase se comporta exactamente igual que antes: este plan no toca el runtime.
- [ ] `grep -rn "orderByDesc('id')" app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` sigue apareciendo, pero precedido de `->primaries()`.

**Lo que este plan deliberadamente NO hace, y hay que saberlo antes de configurar nada en producción:** el runtime todavía no entiende el enlace. Hasta que llegue el segundo plan, una báscula con secundaria configurada seguirá recibiendo `selectPlatform(2)` como si la plataforma 2 estuviera en el mismo equipo, y en una Mettler eso no hará lo que se espera. **Configurar el enlace en producción debe esperar al plan del runtime.** Dar de alta las dos básculas sin enlazarlas es inofensivo.
