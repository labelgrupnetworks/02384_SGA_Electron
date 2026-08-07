# Soporte Mettler en el SGA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el SGA sepa que una báscula tiene marca y modelo, y que hable con VerentiaIP por la API `/scale/*` cuando esté disponible, cayendo al camino de tramas hex cuando el escritorio no esté actualizado.

**Architecture:** Un `ScaleGateway` concentra la decisión de camino: mira `brand` y sondea `GET /health` del escritorio. Los seis métodos de `ScaleController` dejan de cablear `bizerba_hex` y pasan por él. En el navegador, `callElectron()` branchea una sola vez sobre `cfg.api`, de forma que el camino viejo queda aislado y borrable en un commit.

**Tech Stack:** Laravel 12.64, PHP 8.3, PHPUnit (suites `Unit` y `Feature`), Blade, jQuery.

## Global Constraints

- **Repositorio de trabajo:** `/home/manel/Documentos/verentia`. Todas las rutas de este plan son relativas a ahí.
- **Requiere plan A entregado.** Este plan consume `/health`, `/scale/brands` y `/scale/*` de VerentiaIP. Sin ellos, los tests con `Http::fake()` pasan pero la verificación manual no.
- **Ids de marca:** `bizerba` y `mettler_toledo`, exactamente. Son las claves que espera VerentiaIP.
- **`SCALE_COMMANDS['bizerba_hex']` y `SCALE_MAPPINGS['bizerba']` no se borran.** Son el camino de compatibilidad.
- **`SCALE_COMMANDS['mettler_toledo']`, `SCALE_MAPPINGS['mettler_toledo']` y `SCALE_COMMANDS['bizerba']` sí se borran.** Los dos primeros no son MT-SICS y no funcionarían; el tercero no lo usa nadie.
- **Los pesos que llegan de `scale-v1` ya vienen en gramos.** No volver a convertirlos.
- **Un 501 del escritorio se propaga como 501**, no como error genérico.
- Ejecutar tests con `php artisan test --filter=<Clase>`. Estilo con `./vendor/bin/pint`.
- Spec de referencia: el del repo VerentiaIP, `docs/superpowers/specs/2026-07-30-mettler-scale-support-design.md`.

---

### Task 1: Migración de marca, modelo y opciones de protocolo

Tres columnas y un backfill. El orden de los pasos de la migración es lo importante: si se pone un default de golpe, las filas existentes se llevan el valor equivocado.

**Files:**
- Create: `app/Modules/SGA/database/migrations/2026_07_30_120000_add_brand_and_model_to_scales_table.php`
- Modify: `app/Modules/SGA/Models/Scale.php`
- Create: `tests/Feature/Modules/SGA/ScaleBrandMigrationTest.php`

**Interfaces:**
- Consumes: nada.
- Produces:
  - Columnas `scales.brand` (string, NOT NULL, sin default), `scales.model` (string nullable), `scales.protocol_options` (JSON nullable).
  - `Scale::SCALE_BRAND_OPTIONS` — `['mettler_toledo' => 'Mettler Toledo', 'bizerba' => 'Bizerba']`.
  - `Scale::SCALE_MODEL_OPTIONS` — modelos agrupados por marca.
  - `Scale::modelsFor(string $brand): array`

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleBrandMigrationTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Models\Scale;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ScaleBrandMigrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_scales_table_gains_brand_model_and_protocol_options(): void
    {
        $this->assertTrue(Schema::hasColumn('scales', 'brand'));
        $this->assertTrue(Schema::hasColumn('scales', 'model'));
        $this->assertTrue(Schema::hasColumn('scales', 'protocol_options'));
    }

    public function test_brand_options_use_the_ids_verentiaip_expects(): void
    {
        $this->assertSame(
            ['mettler_toledo', 'bizerba'],
            array_keys(Scale::SCALE_BRAND_OPTIONS),
        );
    }

    public function test_models_are_grouped_by_brand(): void
    {
        $this->assertArrayHasKey('mettler_toledo', Scale::SCALE_MODEL_OPTIONS);
        $this->assertArrayHasKey('bizerba', Scale::SCALE_MODEL_OPTIONS);
        $this->assertArrayHasKey('is30', Scale::SCALE_MODEL_OPTIONS['bizerba']);
    }

    public function test_models_for_returns_only_that_brands_models(): void
    {
        $this->assertArrayHasKey('is30', Scale::modelsFor('bizerba'));
        $this->assertArrayNotHasKey('is30', Scale::modelsFor('mettler_toledo'));
        $this->assertSame([], Scale::modelsFor('acme'));
    }

    public function test_protocol_options_round_trips_as_an_array(): void
    {
        $scale = Scale::factory()->create([
            'brand' => 'bizerba',
            'protocol_options' => ['addressPrefix' => ['1', '200', '002']],
        ]);

        $this->assertSame(
            ['addressPrefix' => ['1', '200', '002']],
            $scale->fresh()->protocol_options,
        );
    }

    public function test_brand_model_and_options_are_fillable(): void
    {
        $scale = Scale::factory()->create();
        $scale->fill(['brand' => 'mettler_toledo', 'model' => 'ics425', 'protocol_options' => null]);

        $this->assertSame('mettler_toledo', $scale->brand);
        $this->assertSame('ics425', $scale->model);
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleBrandMigrationTest`
Expected: FAIL — `Schema::hasColumn('scales', 'brand')` devuelve false.

- [ ] **Step 3: Escribir la migración**

```php
<?php
// app/Modules/SGA/database/migrations/2026_07_30_120000_add_brand_and_model_to_scales_table.php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * La marca por defecto NO es Bizerba: lo nuevo que se instale sera Mettler y
     * eso lo decide el formulario. Pero todo lo que existe hoy SI es Bizerba,
     * porque es lo unico que el sistema sabia hablar. Son dos cosas distintas y de
     * ahi los tres pasos: sin ellos, o las filas viejas se marcan como Mettler, o
     * las nuevas heredan un default de Bizerba que ya no toca.
     */
    public function up(): void
    {
        // 1. Nullable y sin default: las filas existentes entran a NULL, limpias.
        Schema::table('scales', function (Blueprint $table) {
            $table->string('brand')->nullable()->after('name');
            $table->string('model')->nullable()->after('brand');
            $table->json('protocol_options')->nullable()->after('model');
        });

        // 2. Backfill explicito.
        DB::table('scales')->whereNull('brand')->update(['brand' => 'bizerba']);

        // 3. Ya sin nulos, se cierra. Sigue sin default: un brand que falte por un
        //    bug debe fallar el insert, no colarse como una fila aparentemente buena.
        Schema::table('scales', function (Blueprint $table) {
            $table->string('brand')->nullable(false)->change();
        });
    }

    /**
     * Destructivo por naturaleza: se pierde la marca, el modelo y las opciones
     * configuradas en cada bascula.
     */
    public function down(): void
    {
        Schema::table('scales', function (Blueprint $table) {
            $table->dropColumn(['brand', 'model', 'protocol_options']);
        });
    }
};
```

- [ ] **Step 4: Actualizar el modelo**

En `app/Modules/SGA/Models/Scale.php`, sustituir la constante `SCALE_MODEL_OPTIONS` actual (que contiene marcas, no modelos) y ampliar `$fillable` y `$casts`:

```php
    /**
     * Marcas soportadas. Las claves son EXACTAMENTE los ids de driver que espera
     * VerentiaIP: si divergen, hay que traducir entre los dos repositorios y eso
     * es una fuente de errores gratuita.
     */
    public const SCALE_BRAND_OPTIONS = [
        'mettler_toledo' => 'Mettler Toledo',
        'bizerba' => 'Bizerba',
    ];

    /**
     * Modelos instalables, agrupados por marca. Este catalogo es a proposito mas
     * amplio que la tabla de overrides de VerentiaIP: alli solo figura lo que se
     * desvia del protocolo base, aqui figura todo lo que se puede instalar, porque
     * tambien sirve de documentacion de que hay montado. Un modelo de aqui sin
     * override alli es el caso normal, no un error.
     */
    public const SCALE_MODEL_OPTIONS = [
        'mettler_toledo' => [
            'ics425' => 'ICS425',
            'ics4xx' => 'ICS4xx (genérico)',
        ],
        'bizerba' => [
            'is30' => 'IS30',
        ],
    ];

    protected $fillable = [
        'workstation_id',
        'name',
        'brand',
        'model',
        'protocol_options',
        'ip_address',
        'port',
        'is_active',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'port' => 'integer',
        'protocol_options' => 'array',
    ];

    /**
     * Modelos disponibles para una marca. Array vacio si la marca no existe.
     *
     * @return array<string, string>
     */
    public static function modelsFor(string $brand): array
    {
        return self::SCALE_MODEL_OPTIONS[$brand] ?? [];
    }
```

- [ ] **Step 5: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleBrandMigrationTest`
Expected: PASS, 6 tests.

Si el test de la factory falla por no conocer `brand`, añadir a la factory de `Scale` (buscarla con `find app/Modules/SGA -name 'ScaleFactory.php'`) los valores por defecto `'brand' => 'bizerba'`, `'model' => null`, `'protocol_options' => null`.

- [ ] **Step 6: Verificar el backfill sobre datos reales**

```bash
php artisan migrate --pretend | tail -20
php artisan migrate
php artisan tinker --execute="echo App\Modules\SGA\Models\Scale::pluck('brand')->countBy();"
```
Expected: todas las básculas preexistentes salen como `bizerba`.

- [ ] **Step 7: Commit**

```bash
git add app/Modules/SGA/database/migrations app/Modules/SGA/Models/Scale.php tests/Feature/Modules/SGA/ScaleBrandMigrationTest.php
git commit -m "feat(sga): add brand, model and protocol options to scales

Three-step migration: nullable column, explicit backfill of every
pre-existing row to bizerba, then NOT NULL. A one-shot default would mark
old rows with whatever the new default is, which is wrong either way.

SCALE_MODEL_OPTIONS held brands, not models. Renamed to
SCALE_BRAND_OPTIONS and the freed name now groups real models by brand."
```

---

### Task 2: Selects dependientes en los formularios

**Files:**
- Create: `app/Modules/SGA/Rules/ModelBelongsToBrand.php`
- Modify: `app/Modules/SGA/Http/Requests/Scale/StoreRequest.php`
- Modify: `app/Modules/SGA/Http/Requests/Scale/UpdateRequest.php`
- Modify: `app/Modules/SGA/UseCases/Scale/StoreUseCase.php`
- Modify: `app/Modules/SGA/UseCases/Scale/UpdateUseCase.php`
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` (métodos `create` y `edit`)
- Modify: `app/Modules/SGA/resources/views/admin/scales/create.blade.php`
- Modify: `app/Modules/SGA/resources/views/admin/scales/edit.blade.php`
- Modify: `app/Modules/SGA/lang/es/cruds/scale.php`
- Modify: `app/Modules/SGA/lang/en/cruds/scale.php`
- Create: `tests/Feature/Modules/SGA/ScaleFormTest.php`

**Interfaces:**
- Consumes: `Scale::SCALE_BRAND_OPTIONS`, `Scale::SCALE_MODEL_OPTIONS`, `Scale::modelsFor()` de Task 1.
- Produces:
  - Regla `ModelBelongsToBrand` — valida `model` contra el `brand` del mismo request.
  - `StoreUseCase::__construct(..., string $brand, ?string $model, ?array $protocol_options)`.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleFormTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ScaleFormTest extends TestCase
{
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Bascula pruebas',
            'brand' => 'mettler_toledo',
            'model' => 'ics425',
            'ip_address' => '192.168.0.86',
            'port' => 4305,
            'workstation_id' => WorkStation::factory()->create()->id,
            'is_active' => '1',
        ], $overrides);
    }

    public function test_it_stores_a_scale_with_brand_and_model(): void
    {
        $this->actingAsSgaAdmin()
            ->post(route('admin.scales.store'), $this->payload())
            ->assertRedirect(route('admin.scales.index'));

        $scale = Scale::where('name', 'Bascula pruebas')->firstOrFail();
        $this->assertSame('mettler_toledo', $scale->brand);
        $this->assertSame('ics425', $scale->model);
    }

    public function test_an_empty_model_is_accepted_and_means_the_family_baseline(): void
    {
        $this->actingAsSgaAdmin()
            ->post(route('admin.scales.store'), $this->payload(['model' => '']))
            ->assertRedirect(route('admin.scales.index'));

        $this->assertNull(Scale::where('name', 'Bascula pruebas')->firstOrFail()->model);
    }

    public function test_it_rejects_an_unknown_brand(): void
    {
        $this->actingAsSgaAdmin()
            ->post(route('admin.scales.store'), $this->payload(['brand' => 'acme']))
            ->assertSessionHasErrors('brand');
    }

    public function test_it_rejects_a_model_that_belongs_to_another_brand(): void
    {
        // is30 es Bizerba: guardarlo como Mettler produciria una bascula que no
        // funciona y un diagnostico imposible.
        $this->actingAsSgaAdmin()
            ->post(route('admin.scales.store'), $this->payload([
                'brand' => 'mettler_toledo',
                'model' => 'is30',
            ]))
            ->assertSessionHasErrors('model');
    }

    public function test_it_rejects_a_model_that_does_not_exist_at_all(): void
    {
        $this->actingAsSgaAdmin()
            ->post(route('admin.scales.store'), $this->payload(['model' => 'inventado']))
            ->assertSessionHasErrors('model');
    }

    public function test_the_create_form_preselects_mettler_and_offers_both_brands(): void
    {
        $response = $this->actingAsSgaAdmin()->get(route('admin.scales.create'));

        $response->assertOk()
            ->assertSee('mettler_toledo')
            ->assertSee('bizerba')
            ->assertSee('scaleModelOptions', escape: false);
    }

    public function test_it_updates_the_brand_of_an_existing_scale(): void
    {
        $scale = Scale::factory()->create(['brand' => 'bizerba', 'model' => 'is30']);

        $this->actingAsSgaAdmin()
            ->put(route('admin.scales.update', $scale), $this->payload([
                'name' => $scale->name,
                'brand' => 'mettler_toledo',
                'model' => 'ics425',
            ]))
            ->assertRedirect(route('admin.scales.edit', $scale->id));

        $scale->refresh();
        $this->assertSame('mettler_toledo', $scale->brand);
        $this->assertSame('ics425', $scale->model);
    }
}
```

Este test usa un helper `actingAsSgaAdmin()`. Comprobar si ya existe en `tests/TestCase.php` con
`grep -rn "actingAsSgaAdmin\|function actingAs" tests/TestCase.php tests/`. Si no existe, copiar el
patrón de autenticación de otro test de módulo SGA que ya pase, por ejemplo el que se encuentre
con `grep -rln "admin.scales\|sga_scale" tests/`.

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleFormTest`
Expected: FAIL — el `brand` no se guarda porque `StoreUseCase` no lo recibe.

- [ ] **Step 3: Crear la regla de validación cruzada**

```php
<?php
// app/Modules/SGA/Rules/ModelBelongsToBrand.php

declare(strict_types=1);

namespace App\Modules\SGA\Rules;

use App\Modules\SGA\Models\Scale;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * El modelo debe pertenecer a la marca elegida en el mismo formulario.
 *
 * Un `in:` plano sobre todos los modelos dejaria pasar un IS30 marcado como
 * Mettler, y eso produce una bascula que no responde con un diagnostico imposible.
 */
class ModelBelongsToBrand implements ValidationRule
{
    public function __construct(private readonly ?string $brand)
    {
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if ($value === null || $value === '') {
            return; // Vacio es valido: significa linea base de la familia.
        }

        if ($this->brand === null || !array_key_exists($this->brand, Scale::SCALE_MODEL_OPTIONS)) {
            return; // La marca ya la rechaza su propia regla; no duplicar el error.
        }

        if (!array_key_exists($value, Scale::modelsFor($this->brand))) {
            $fail(__('SGA::messages.scale.model_not_in_brand'));
        }
    }
}
```

- [ ] **Step 4: Añadir las reglas a los dos requests**

En `StoreRequest::rules()` y `UpdateRequest::rules()`, añadir al array devuelto:

```php
            'brand' => ['required', 'string', Rule::in(array_keys(Scale::SCALE_BRAND_OPTIONS))],
            'model' => ['nullable', 'string', 'max:50', new ModelBelongsToBrand($this->input('brand'))],
            'protocol_options' => ['nullable', 'array'],
```

Y los `use` correspondientes en cada fichero:

```php
use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Rules\ModelBelongsToBrand;
use Illuminate\Validation\Rule;
```

- [ ] **Step 5: Añadir los mensajes de idioma**

En `app/Modules/SGA/lang/es/cruds/scale.php`, dentro de `'fields'`:

```php
        'brand' => 'Marca',
        'brand_helper' => 'Protocolo con el que se comunica la báscula',
        'model' => 'Modelo',
        'model_helper' => 'Déjalo vacío salvo que el equipo se desvíe del protocolo estándar de la marca',
```

En `app/Modules/SGA/lang/es/messages.php`, dentro del array `'scale'`:

```php
        'model_not_in_brand' => 'El modelo seleccionado no pertenece a la marca elegida',
```

Replicar las mismas claves en `app/Modules/SGA/lang/en/cruds/scale.php` y
`app/Modules/SGA/lang/en/messages.php`:

```php
        'brand' => 'Brand',
        'brand_helper' => 'Protocol the scale speaks',
        'model' => 'Model',
        'model_helper' => 'Leave empty unless the device deviates from the brand default protocol',
```
```php
        'model_not_in_brand' => 'The selected model does not belong to the chosen brand',
```

- [ ] **Step 6: Pasar los datos a las vistas**

En `ScaleController::create()`:

```php
    public function create(): View
    {
        $workstations = WorkStation::pluck('name', 'id');
        $brands = Scale::SCALE_BRAND_OPTIONS;
        $modelsByBrand = Scale::SCALE_MODEL_OPTIONS;

        return view('SGA::admin.scales.create', compact('workstations', 'brands', 'modelsByBrand'));
    }
```

En `ScaleController::edit()`:

```php
    public function edit(Scale $scale): View
    {
        $workstations = WorkStation::pluck('name', 'id');
        $brands = Scale::SCALE_BRAND_OPTIONS;
        $modelsByBrand = Scale::SCALE_MODEL_OPTIONS;

        return view('SGA::admin.scales.edit', compact('scale', 'workstations', 'brands', 'modelsByBrand'));
    }
```

- [ ] **Step 7: Añadir los dos selects a create.blade.php**

En `app/Modules/SGA/resources/views/admin/scales/create.blade.php`, insertar tras el bloque del campo `name`:

```blade
                    <div class="form-group col-12 col-md-6">
                        <label class="required" for="brand">{{ trans('SGA::cruds/scale.fields.brand') }}</label>
                        <select class="form-control {{ $errors->has('brand') ? 'is-invalid' : '' }}" id="brand" name="brand" required>
                            @foreach ($brands as $value => $label)
                                <option value="{{ $value }}" {{ old('brand', 'mettler_toledo') === $value ? 'selected' : '' }}>
                                    {{ $label }}
                                </option>
                            @endforeach
                        </select>
                        @if ($errors->has('brand'))
                            <span class="text-danger">{{ $errors->first('brand') }}</span>
                        @endif
                        <span class="help-block">{{ trans('SGA::cruds/scale.fields.brand_helper') }}</span>
                    </div>

                    <div class="form-group col-12 col-md-6">
                        <label for="model">{{ trans('SGA::cruds/scale.fields.model') }}</label>
                        <select class="form-control {{ $errors->has('model') ? 'is-invalid' : '' }}" id="model" name="model">
                            <option value="">{{ trans('SGA::cruds/scale.fields.model_generic') }}</option>
                        </select>
                        @if ($errors->has('model'))
                            <span class="text-danger">{{ $errors->first('model') }}</span>
                        @endif
                        <span class="help-block">{{ trans('SGA::cruds/scale.fields.model_helper') }}</span>
                    </div>
```

Y al final del fichero, después de `@endsection`:

```blade
@section('scripts')
@parent
<script>
    // El select de modelo se rellena desde el catalogo de la marca elegida. Filtrar
    // en cliente evita una peticion y mantiene una sola fuente: la constante del modelo.
    const scaleModelOptions = @json($modelsByBrand);
    const genericLabel = @json(trans('SGA::cruds/scale.fields.model_generic'));
    const selectedModel = @json(old('model'));

    function refreshModelOptions() {
        const brand = document.getElementById('brand').value;
        const select = document.getElementById('model');
        const models = scaleModelOptions[brand] || {};

        select.innerHTML = '';
        select.appendChild(new Option(genericLabel, ''));
        for (const [value, label] of Object.entries(models)) {
            select.appendChild(new Option(label, value, false, value === selectedModel));
        }
    }

    document.getElementById('brand').addEventListener('change', refreshModelOptions);
    refreshModelOptions();
</script>
@endsection
```

Añadir también la clave del texto genérico. En `lang/es/cruds/scale.php`:

```php
        'model_generic' => 'Genérico (línea base de la marca)',
```

En `lang/en/cruds/scale.php`:

```php
        'model_generic' => 'Generic (brand baseline)',
```

- [ ] **Step 8: Replicar en edit.blade.php**

Mismos dos bloques de campo, cambiando los `old()` por el valor guardado:

```blade
{{ old('brand', $scale->brand) === $value ? 'selected' : '' }}
```

Y en el script, `const selectedModel = @json(old('model', $scale->model));`.

- [ ] **Step 9: Pasar los parámetros a los casos de uso**

En `StoreUseCase`:

```php
    public function __construct(
        protected string $name,
        protected string $brand,
        protected ?string $model,
        protected ?array $protocol_options,
        protected string $ip_address,
        protected int $port,
        protected int $workstation_id,
        protected bool $is_active = false,
    ) {
    }

    public function action(): Scale
    {
        return Scale::create([
            'name' => $this->name,
            'brand' => $this->brand,
            'model' => $this->model,
            'protocol_options' => $this->protocol_options,
            'ip_address' => $this->ip_address,
            'port' => $this->port,
            'workstation_id' => $this->workstation_id,
            'is_active' => $this->is_active,
        ]);
    }
```

En `ScaleController::store()`, pasar los nuevos argumentos:

```php
        $useCase = new \App\Modules\SGA\UseCases\Scale\StoreUseCase(
            name: $validated['name'],
            brand: $validated['brand'],
            model: $validated['model'] ?: null,
            protocol_options: $validated['protocol_options'] ?? null,
            ip_address: $validated['ip_address'],
            port: $validated['port'],
            workstation_id: $validated['workstation_id'],
            is_active: $validated['is_active'],
        );
```

Aplicar el cambio equivalente en `UpdateUseCase` y `ScaleController::update()`.

- [ ] **Step 10: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleFormTest`
Expected: PASS, 7 tests.

- [ ] **Step 11: Verificar el formulario en el navegador**

Abrir `/admin/scales/create`. Comprobar que la marca sale preseleccionada en Mettler Toledo, que
el select de modelo ofrece ICS425 e ICS4xx, y que al cambiar a Bizerba pasa a ofrecer IS30 y no
ICS425. Guardar una báscula Mettler y comprobar que aparece en el listado.

- [ ] **Step 12: Estilo y commit**

```bash
./vendor/bin/pint app/Modules/SGA/Rules app/Modules/SGA/Http/Requests/Scale app/Modules/SGA/UseCases/Scale
git add app/Modules/SGA tests/Feature/Modules/SGA/ScaleFormTest.php
git commit -m "feat(sga): add brand and dependent model selects to the scale form

Model is validated against its brand, not with a flat in: rule, because
a flat rule would let an IS30 be saved as a Mettler — a scale that never
answers and cannot be diagnosed. Empty model stays valid and means the
family baseline."
```

---

### Task 3: ScaleGateway

La pieza central. Decide camino, habla con el escritorio y devuelve siempre la misma forma, de modo que el controlador no sepa si detrás hubo una trama hex o un endpoint nuevo.

**Files:**
- Create: `app/Modules/SGA/Services/ScaleResponse.php`
- Create: `app/Modules/SGA/Services/ScaleGateway.php`
- Create: `tests/Unit/Modules/SGA/Services/ScaleGatewayTest.php`

**Interfaces:**
- Consumes: `Scale` de Task 1, `ScaleWeightParser` (existente, sin cambios), `ScaleController::SCALE_COMMANDS['bizerba_hex']` y `SCALE_MAPPINGS['bizerba']` (existentes).
- Produces:
  - `ScaleResponse` — objeto de sólo lectura: `success`, `status`, `data`, `raw`, `errorCode`, `message`, `api`.
  - `ScaleGateway::apiFor(Scale $scale): string` — `'scale-v1'` o `'legacy'`.
  - `ScaleGateway::health(): ?array` — `null` si el escritorio no tiene `/health`. Memoizado por instancia.
  - `ScaleGateway::call(Scale $scale, string $operation, array $params = []): ScaleResponse` — operaciones: `info`, `tare`, `clearTare`, `weigh`, `selectPlatform`.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Unit/Modules/SGA/Services/ScaleGatewayTest.php

declare(strict_types=1);

namespace Tests\Unit\Modules\SGA\Services;

use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Services\ScaleGateway;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ScaleGatewayTest extends TestCase
{
    private const DESKTOP = 'http://localhost:3000';

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('sga.desktop_app_service', self::DESKTOP);
    }

    private function scale(array $attributes = []): Scale
    {
        return new Scale(array_merge([
            'name' => 'B1',
            'brand' => 'mettler_toledo',
            'model' => null,
            'protocol_options' => null,
            'ip_address' => '192.168.0.86',
            'port' => 4305,
        ], $attributes));
    }

    private function fakeHealthy(array $extra = []): void
    {
        Http::fake(array_merge([
            self::DESKTOP . '/health' => Http::response([
                'version' => '1.3.0',
                'apis' => ['legacy', 'scale-v1'],
                'brands' => ['mettler_toledo', 'bizerba'],
            ]),
        ], $extra));
    }

    public function test_a_modern_desktop_app_resolves_to_scale_v1(): void
    {
        $this->fakeHealthy();
        $this->assertSame('scale-v1', (new ScaleGateway())->apiFor($this->scale()));
    }

    public function test_a_404_on_health_means_the_desktop_app_is_old(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);
        $this->assertNull((new ScaleGateway())->health());
    }

    public function test_an_old_desktop_app_falls_back_to_legacy_for_bizerba(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);
        $gateway = new ScaleGateway();
        $this->assertSame('legacy', $gateway->apiFor($this->scale(['brand' => 'bizerba', 'port' => 10051])));
    }

    public function test_health_is_probed_once_per_instance(): void
    {
        $this->fakeHealthy();
        $gateway = new ScaleGateway();
        $gateway->health();
        $gateway->health();
        $gateway->health();

        Http::assertSentCount(1);
    }

    public function test_an_old_desktop_app_cannot_serve_a_mettler(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = (new ScaleGateway())->call($this->scale(), 'weigh');

        // Una Mettler no tiene camino legacy que funcione: error explicito antes que
        // un intento silencioso que deja al operario sin pista.
        $this->assertFalse($response->success);
        $this->assertSame('desktop_outdated', $response->errorCode);
    }

    public function test_an_old_desktop_app_cannot_honour_a_model_override(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = (new ScaleGateway())->call(
            $this->scale(['brand' => 'bizerba', 'port' => 10051, 'model' => 'is30']),
            'tare',
        );

        // El camino legacy manda tramas ya montadas y no sabe aplicar overrides.
        $this->assertFalse($response->success);
        $this->assertSame('desktop_outdated', $response->errorCode);
    }

    public function test_an_old_desktop_app_cannot_honour_protocol_options(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = (new ScaleGateway())->call(
            $this->scale([
                'brand' => 'bizerba',
                'port' => 10051,
                'protocol_options' => ['addressPrefix' => ['1', '200', '002']],
            ]),
            'weigh',
        );

        $this->assertFalse($response->success);
        $this->assertSame('desktop_outdated', $response->errorCode);
    }

    public function test_scale_v1_weigh_forwards_ip_port_brand_model_and_options(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/weigh' => Http::response([
                'success' => true, 'brand' => 'mettler_toledo', 'op' => 'weigh',
                'data' => [
                    'net' => ['value' => 1234, 'unit' => 'g'],
                    'tare' => ['value' => 50, 'unit' => 'g'],
                    'gross' => ['value' => 1284, 'unit' => 'g'],
                    'stable' => true,
                ],
                'raw' => ['S S 1.234 kg'],
            ]),
        ]);

        $response = (new ScaleGateway())->call(
            $this->scale(['model' => 'ics425', 'protocol_options' => ['foo' => 'bar']]),
            'weigh',
        );

        $this->assertTrue($response->success);
        $this->assertSame(1234, $response->data['net']['value']);
        $this->assertSame('scale-v1', $response->api);

        Http::assertSent(function ($request) {
            return $request->url() === self::DESKTOP . '/scale/weigh'
                && $request['ip'] === '192.168.0.86'
                && $request['port'] === 4305
                && $request['brand'] === 'mettler_toledo'
                && $request['model'] === 'ics425'
                && $request['options'] === ['foo' => 'bar'];
        });
    }

    public function test_scale_v1_omits_model_and_options_when_they_are_null(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/tare' => Http::response([
                'success' => true, 'op' => 'tare', 'data' => [], 'raw' => [],
            ]),
        ]);

        (new ScaleGateway())->call($this->scale(), 'tare');

        Http::assertSent(function ($request) {
            if ($request->url() !== self::DESKTOP . '/scale/tare') {
                return true;
            }
            return !array_key_exists('model', $request->data())
                && !array_key_exists('options', $request->data());
        });
    }

    public function test_a_501_from_the_desktop_is_preserved_as_not_supported(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/zero' => Http::response([
                'success' => false, 'brand' => 'bizerba', 'op' => 'zero',
                'error' => ['code' => 'not_supported', 'message' => 'no soportada', 'detail' => null],
            ], 501),
        ]);

        $response = (new ScaleGateway())->call($this->scale(['brand' => 'bizerba']), 'zero');

        $this->assertFalse($response->success);
        $this->assertSame(501, $response->status);
        $this->assertSame('not_supported', $response->errorCode);
    }

    public function test_a_504_timeout_keeps_its_code_and_status(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/weigh' => Http::response([
                'success' => false, 'op' => 'weigh',
                'error' => ['code' => 'timeout', 'message' => 'sin respuesta', 'detail' => null],
            ], 504),
        ]);

        $response = (new ScaleGateway())->call($this->scale(), 'weigh');

        $this->assertSame(504, $response->status);
        $this->assertSame('timeout', $response->errorCode);
    }

    public function test_select_platform_forwards_the_number(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/select-platform' => Http::response([
                'success' => true, 'op' => 'selectPlatform', 'data' => ['platform' => 2], 'raw' => [],
            ]),
        ]);

        $response = (new ScaleGateway())->call($this->scale(), 'selectPlatform', ['platform' => 2]);

        $this->assertTrue($response->success);
        Http::assertSent(function ($request) {
            return $request->url() !== self::DESKTOP . '/scale/select-platform'
                || $request['platform'] === 2;
        });
    }

    public function test_clear_tare_uses_the_kebab_case_route(): void
    {
        $this->fakeHealthy([
            self::DESKTOP . '/scale/clear-tare' => Http::response([
                'success' => true, 'op' => 'clearTare', 'data' => [], 'raw' => [],
            ]),
        ]);

        $this->assertTrue((new ScaleGateway())->call($this->scale(), 'clearTare')->success);
    }

    public function test_legacy_weigh_sends_the_hex_telegram_and_parses_grams(): void
    {
        Http::fake([
            self::DESKTOP . '/health' => Http::response(null, 404),
            self::DESKTOP . '/scale-hex' => Http::response([
                'success' => true,
                'response_hex' => '',
                'response_ascii' => 'I!LV01|GD01|kg;-3;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02',
            ]),
        ]);

        $response = (new ScaleGateway())->call(
            $this->scale(['brand' => 'bizerba', 'port' => 10051]),
            'weigh',
        );

        $this->assertTrue($response->success);
        $this->assertSame('legacy', $response->api);
        // El camino legacy normaliza con ScaleWeightParser, que ya da gramos.
        $this->assertSame(1234.0, $response->data['net']['value']);
        $this->assertSame('g', $response->data['net']['unit']);
        $this->assertSame(1284.0, $response->data['gross']['value']);
    }

    public function test_legacy_tare_sends_the_tare_telegram(): void
    {
        Http::fake([
            self::DESKTOP . '/health' => Http::response(null, 404),
            self::DESKTOP . '/scale-hex' => Http::response([
                'success' => true, 'response_hex' => '', 'response_ascii' => 'OK',
            ]),
        ]);

        $this->assertTrue((new ScaleGateway())->call(
            $this->scale(['brand' => 'bizerba', 'port' => 10051]),
            'tare',
        )->success);

        Http::assertSent(function ($request) {
            return $request->url() !== self::DESKTOP . '/scale-hex'
                || str_contains((string) $request['hex'], '49 21 47 58 30 35'); // I!GX05
        });
    }

    public function test_legacy_rejects_an_operation_it_has_no_telegram_for(): void
    {
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = (new ScaleGateway())->call(
            $this->scale(['brand' => 'bizerba', 'port' => 10051]),
            'zero',
        );

        $this->assertFalse($response->success);
        $this->assertSame('not_supported', $response->errorCode);
        $this->assertSame(501, $response->status);
    }

    public function test_a_desktop_app_that_is_unreachable_is_reported_as_such(): void
    {
        Http::fake(fn () => throw new \Illuminate\Http\Client\ConnectionException('sin ruta'));

        $response = (new ScaleGateway())->call($this->scale(), 'weigh');

        $this->assertFalse($response->success);
        $this->assertSame('desktop_unreachable', $response->errorCode);
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleGatewayTest`
Expected: FAIL — `Class "App\Modules\SGA\Services\ScaleGateway" not found`

- [ ] **Step 3: Crear el objeto de respuesta**

```php
<?php
// app/Modules/SGA/Services/ScaleResponse.php

declare(strict_types=1);

namespace App\Modules\SGA\Services;

/**
 * Resultado de una operacion de bascula, con la misma forma venga del endpoint
 * nuevo o de una trama hex. Que el controlador no pueda distinguirlos es el punto.
 */
final class ScaleResponse
{
    /**
     * @param array<string, mixed> $data
     * @param array<int, string> $raw
     */
    public function __construct(
        public readonly bool $success,
        public readonly int $status,
        public readonly string $api,
        public readonly array $data = [],
        public readonly array $raw = [],
        public readonly ?string $errorCode = null,
        public readonly ?string $message = null,
    ) {
    }

    /** @param array<string, mixed> $data */
    public static function ok(string $api, array $data = [], array $raw = []): self
    {
        return new self(true, 200, $api, $data, $raw);
    }

    public static function error(string $api, int $status, string $code, string $message): self
    {
        return new self(false, $status, $api, [], [], $code, $message);
    }
}
```

- [ ] **Step 4: Implementar el gateway**

```php
<?php
// app/Modules/SGA/Services/ScaleGateway.php

declare(strict_types=1);

namespace App\Modules\SGA\Services;

use App\Modules\SGA\Http\Controllers\Admin\ScaleController;
use App\Modules\SGA\Models\Scale;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Punto unico de contacto con la app de escritorio.
 *
 * Decide entre dos caminos: la API `/scale/*`, que conoce el protocolo, y el
 * `/scale-hex` heredado, que manda tramas ya montadas. La senal es el 404: un
 * VerentiaIP anterior no tiene `/health`.
 */
class ScaleGateway
{
    public const API_V1 = 'scale-v1';
    public const API_LEGACY = 'legacy';

    /** Operacion -> clave en SCALE_COMMANDS['bizerba_hex']. Lo que no este aqui no tiene camino legacy. */
    private const LEGACY_TELEGRAMS = [
        'info' => 'info',
        'tare' => 'tare',
        'clearTare' => 'delete_tare',
        'weigh' => 'get_weights',
    ];

    /** camelCase -> kebab-case, igual que hace scale-routes.js en VerentiaIP. */
    private const V1_ROUTES = [
        'weigh' => 'weigh',
        'tare' => 'tare',
        'clearTare' => 'clear-tare',
        'zero' => 'zero',
        'info' => 'info',
        'selectPlatform' => 'select-platform',
        'display' => 'display',
        'displayClear' => 'display-clear',
        'beep' => 'beep',
        'guidedWeigh' => 'guided-weigh',
    ];

    private bool $healthProbed = false;

    /** @var array<string, mixed>|null */
    private ?array $healthPayload = null;

    private function baseUrl(): string
    {
        return rtrim((string) config('sga.desktop_app_service'), '/');
    }

    /**
     * Respuesta de GET /health, o null si el escritorio no lo tiene (404) o no
     * responde. Memoizado: una peticion por instancia, no una por operacion.
     *
     * @return array<string, mixed>|null
     */
    public function health(): ?array
    {
        if ($this->healthProbed) {
            return $this->healthPayload;
        }

        $this->healthProbed = true;

        try {
            $response = Http::timeout(3)->get($this->baseUrl() . '/health');
            $this->healthPayload = $response->successful() ? $response->json() : null;
        } catch (ConnectionException $exception) {
            Log::debug('ScaleGateway: escritorio no alcanzable en /health', [
                'message' => $exception->getMessage(),
            ]);
            $this->healthPayload = null;
        }

        return $this->healthPayload;
    }

    public function apiFor(Scale $scale): string
    {
        $health = $this->health();
        $apis = $health['apis'] ?? [];
        $brands = $health['brands'] ?? [];

        if (in_array(self::API_V1, $apis, true) && in_array($scale->brand, $brands, true)) {
            return self::API_V1;
        }

        return self::API_LEGACY;
    }

    /**
     * @param array<string, mixed> $params
     */
    public function call(Scale $scale, string $operation, array $params = []): ScaleResponse
    {
        $api = $this->apiFor($scale);

        if ($api === self::API_LEGACY) {
            $blocker = $this->legacyBlocker($scale);
            if ($blocker !== null) {
                return $blocker;
            }
            return $this->callLegacy($scale, $operation, $params);
        }

        return $this->callV1($scale, $operation, $params);
    }

    /**
     * Combinaciones que el camino legacy no puede honrar. Se responde con error
     * explicito en vez de intentarlo: aplicar el prefijo por defecto en silencio
     * dejaria una bascula muda y ninguna pista de por que.
     */
    private function legacyBlocker(Scale $scale): ?ScaleResponse
    {
        if ($scale->brand !== 'bizerba') {
            return ScaleResponse::error(
                self::API_LEGACY, 500, 'desktop_outdated',
                __('SGA::messages.scale.desktop_outdated_brand', ['brand' => $scale->brand]),
            );
        }

        if ($scale->model !== null || !empty($scale->protocol_options)) {
            return ScaleResponse::error(
                self::API_LEGACY, 500, 'desktop_outdated',
                __('SGA::messages.scale.desktop_outdated_options'),
            );
        }

        return null;
    }

    /** @param array<string, mixed> $params */
    private function callV1(Scale $scale, string $operation, array $params): ScaleResponse
    {
        $route = self::V1_ROUTES[$operation] ?? null;
        if ($route === null) {
            return ScaleResponse::error(
                self::API_V1, 500, 'unknown_operation',
                "Operación de báscula desconocida: {$operation}",
            );
        }

        $payload = array_merge($params, [
            'ip' => $scale->ip_address,
            'port' => $scale->port,
            'brand' => $scale->brand,
        ]);

        // Se omiten cuando son nulos para que el driver aplique su linea base.
        if ($scale->model !== null) {
            $payload['model'] = $scale->model;
        }
        if (!empty($scale->protocol_options)) {
            $payload['options'] = $scale->protocol_options;
        }

        try {
            $response = Http::timeout(20)->post($this->baseUrl() . "/scale/{$route}", $payload);
        } catch (ConnectionException $exception) {
            return ScaleResponse::error(
                self::API_V1, 500, 'desktop_unreachable',
                __('SGA::messages.scale.desktop_unreachable'),
            );
        }

        $body = $response->json() ?? [];

        if ($response->successful() && ($body['success'] ?? false) === true) {
            return ScaleResponse::ok(self::API_V1, $body['data'] ?? [], $body['raw'] ?? []);
        }

        // El 501 se conserva tal cual: distingue "esta bascula no sabe" de "fallo".
        return new ScaleResponse(
            success: false,
            status: $response->status(),
            api: self::API_V1,
            data: [],
            raw: $body['raw'] ?? [],
            errorCode: $body['error']['code'] ?? 'protocol',
            message: $body['error']['message'] ?? __('SGA::messages.scale.scale_command_failed'),
        );
    }

    /** @param array<string, mixed> $params */
    private function callLegacy(Scale $scale, string $operation, array $params = []): ScaleResponse
    {
        // selectPlatform no cabe en la tabla generica: hay una trama por plataforma.
        if ($operation === 'selectPlatform') {
            $platform = (int) ($params['platform'] ?? 0);
            if (!in_array($platform, [1, 2], true)) {
                return ScaleResponse::error(
                    self::API_LEGACY, 400, 'protocol',
                    __('SGA::messages.scale.invalid_scale_number'),
                );
            }
            $key = $platform === 1 ? 'change_to_1' : 'change_to_2';
        } else {
            $key = self::LEGACY_TELEGRAMS[$operation] ?? null;
        }

        if ($key === null) {
            return ScaleResponse::error(
                self::API_LEGACY, 501, 'not_supported',
                __('SGA::messages.scale.operation_not_supported', ['operation' => $operation]),
            );
        }

        $hex = ScaleController::SCALE_COMMANDS['bizerba_hex'][$key];

        try {
            $response = Http::timeout(20)->post($this->baseUrl() . '/scale-hex', [
                'ip' => $scale->ip_address,
                'port' => $scale->port,
                'hex' => $hex,
            ]);
        } catch (ConnectionException $exception) {
            return ScaleResponse::error(
                self::API_LEGACY, 500, 'desktop_unreachable',
                __('SGA::messages.scale.desktop_unreachable'),
            );
        }

        $body = $response->json() ?? [];

        if (!$response->successful() || ($body['success'] ?? false) !== true) {
            return ScaleResponse::error(
                self::API_LEGACY, 500, 'protocol',
                $body['error'] ?? __('SGA::messages.scale.scale_command_failed'),
            );
        }

        $ascii = is_string($body['response_ascii'] ?? null) ? $body['response_ascii'] : '';

        if ($operation !== 'weigh') {
            return ScaleResponse::ok(self::API_LEGACY, ['raw_info' => $ascii], [$ascii]);
        }

        $weights = (new ScaleWeightParser())->parse($ascii, ScaleController::SCALE_MAPPINGS['bizerba']);

        return ScaleResponse::ok(self::API_LEGACY, $weights, [$ascii]);
    }
}
```

- [ ] **Step 5: Añadir los mensajes de idioma**

En `app/Modules/SGA/lang/es/messages.php`, dentro del array `'scale'`:

```php
        'desktop_outdated_brand' => 'La aplicación de escritorio de este puesto es antigua y no sabe comunicarse con básculas :brand. Espera a que se actualice o actualízala manualmente.',
        'desktop_outdated_options' => 'Esta báscula tiene modelo u opciones de protocolo configurados, y la aplicación de escritorio de este puesto es demasiado antigua para aplicarlos.',
        'desktop_unreachable' => 'No se puede contactar con la aplicación de escritorio de este puesto.',
        'operation_not_supported' => 'Esta báscula no soporta la operación :operation',
```

Y en `app/Modules/SGA/lang/en/messages.php`:

```php
        'desktop_outdated_brand' => 'The desktop app on this workstation is outdated and cannot talk to :brand scales. Wait for it to update or update it manually.',
        'desktop_outdated_options' => 'This scale has a model or protocol options configured, and the desktop app on this workstation is too old to apply them.',
        'desktop_unreachable' => 'Cannot reach the desktop app on this workstation.',
        'operation_not_supported' => 'This scale does not support the :operation operation',
```

- [ ] **Step 6: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ScaleGatewayTest`
Expected: PASS, 17 tests.

- [ ] **Step 7: Estilo y commit**

```bash
./vendor/bin/pint app/Modules/SGA/Services
git add app/Modules/SGA/Services app/Modules/SGA/lang tests/Unit/Modules/SGA/Services/ScaleGatewayTest.php
git commit -m "feat(sga): add ScaleGateway with scale-v1 and legacy paths

One place decides which path a scale takes. The signal is the 404 on
/health: an older VerentiaIP does not have it. A 501 from the desktop is
preserved rather than flattened, so 'this scale cannot do that' stays
distinguishable from 'the attempt failed'.

Combinations legacy cannot honour — a Mettler, or a model/options
override — fail explicitly instead of silently using defaults and leaving
a mute scale with no clue why."
```

---

### Task 4: Los seis métodos del controlador pasan por el gateway

Aquí desaparece el `// TODO: Assuming we're working with Bizerba scales` y se borran los placeholders `mettler_toledo` que no son MT-SICS.

**Files:**
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php`
- Create: `tests/Feature/Modules/SGA/ScaleControllerBrandTest.php`

**Interfaces:**
- Consumes: `ScaleGateway` y `ScaleResponse` de Task 3.
- Produces: nada nuevo. Los seis endpoints conservan sus rutas y sus claves de respuesta.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ScaleControllerBrandTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Http\Controllers\Admin\ScaleController;
use App\Modules\SGA\Models\Scale;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ScaleControllerBrandTest extends TestCase
{
    use RefreshDatabase;

    private const DESKTOP = 'http://localhost:3000';

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('sga.desktop_app_service', self::DESKTOP);
    }

    public function test_the_mettler_placeholder_command_maps_are_gone(): void
    {
        // 'info' => 'I', 'change_to_1' => 'SCALE,1' no son MT-SICS y no funcionarian.
        // Dejarlas es una trampa para el siguiente que las lea y las crea buenas.
        $this->assertArrayNotHasKey('mettler_toledo', ScaleController::SCALE_COMMANDS);
        $this->assertArrayNotHasKey('mettler_toledo', ScaleController::SCALE_MAPPINGS);
    }

    public function test_the_unused_non_hex_bizerba_map_is_gone(): void
    {
        $this->assertArrayNotHasKey('bizerba', ScaleController::SCALE_COMMANDS);
    }

    public function test_the_legacy_compatibility_maps_are_kept(): void
    {
        $this->assertArrayHasKey('bizerba_hex', ScaleController::SCALE_COMMANDS);
        $this->assertArrayHasKey('bizerba', ScaleController::SCALE_MAPPINGS);
    }

    public function test_test_connection_uses_the_brand_of_the_scale(): void
    {
        $scale = Scale::factory()->create([
            'brand' => 'mettler_toledo', 'ip_address' => '192.168.0.86', 'port' => 4305,
        ]);

        Http::fake([
            self::DESKTOP . '/health' => Http::response([
                'version' => '1.3.0', 'apis' => ['legacy', 'scale-v1'],
                'brands' => ['mettler_toledo', 'bizerba'],
            ]),
            self::DESKTOP . '/scale/info' => Http::response([
                'success' => true, 'op' => 'info',
                'data' => ['model' => 'ICS425-BW', 'serial' => 'C614409345'],
                'raw' => ['I2 A "ICS425-BW 3.0045 kg"'],
            ]),
        ]);

        $this->actingAsSgaAdmin()
            ->getJson(route('admin.scales.test-connection', $scale))
            ->assertOk()
            ->assertJson(['connected' => true]);

        Http::assertSent(fn ($request) => $request->url() !== self::DESKTOP . '/scale/info'
            || $request['brand'] === 'mettler_toledo');
    }

    public function test_test_connection_reports_failure_when_the_scale_does_not_answer(): void
    {
        $scale = Scale::factory()->create(['brand' => 'mettler_toledo', 'port' => 4305]);

        Http::fake([
            self::DESKTOP . '/health' => Http::response([
                'version' => '1.3.0', 'apis' => ['legacy', 'scale-v1'],
                'brands' => ['mettler_toledo', 'bizerba'],
            ]),
            self::DESKTOP . '/scale/info' => Http::response([
                'success' => false, 'op' => 'info',
                'error' => ['code' => 'connect', 'message' => 'sin ruta', 'detail' => null],
            ], 502),
        ]);

        $this->actingAsSgaAdmin()
            ->getJson(route('admin.scales.test-connection', $scale))
            ->assertOk()
            ->assertJson(['connected' => false]);
    }

    public function test_a_501_from_the_desktop_reaches_the_client_as_501(): void
    {
        $this->markTestSkipped(
            'Requiere la ruta que expone getWeights/tare por workstation; se cubre '
            . 'en cuanto exista una ruta con scale explicito. El comportamiento del '
            . 'gateway ya esta cubierto en ScaleGatewayTest.'
        );
    }
}
```

Nota sobre ese último test: los métodos `info`, `tare`, `deleteTare`, `changeToScale` y
`getWeights` resuelven la báscula por IP del puesto mediante `findScale()`, que llama a
`GET /ip` del escritorio. Eso los hace incómodos de probar en Feature sin montar también el
puesto y la IP. La cobertura real de la propagación del 501 está en `ScaleGatewayTest`, que es
donde vive la lógica. Este test queda marcado como saltado y con el motivo escrito, en vez de
borrado y en vez de fingido.

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ScaleControllerBrandTest`
Expected: FAIL — `SCALE_COMMANDS` todavía tiene la clave `mettler_toledo`.

- [ ] **Step 3: Limpiar las constantes**

En `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php`, sustituir todo el bloque
`SCALE_COMMANDS` y `SCALE_MAPPINGS` por:

```php
    /**
     * Tramas Bizerba en hexadecimal, para el endpoint /scale-hex heredado.
     *
     * <ETX> es 03 y el 0D 0A final va incluido porque /scale-hex envia el payload
     * crudo y NO anade terminador (a diferencia de /scale-command). El prefijo
     * 30 03 32 35 34 03 30 30 31 03 == "0<ETX>254<ETX>001<ETX>".
     *
     * Se conserva solo como camino de compatibilidad: cuando la app de escritorio
     * soporta scale-v1, el protocolo lo pone ella y esto no se usa. Los mapas de
     * Mettler que habia aqui se han eliminado: no eran MT-SICS y no funcionaban.
     */
    public const SCALE_COMMANDS = [
        'bizerba_hex' => [
            // I?GV05|LX02
            'info' => '30 03 32 35 34 03 30 30 31 03 49 3F 47 56 30 35 7C 4C 58 30 32 0D 0A',
            // I!GX06
            'delete_tare' => '30 03 32 35 34 03 30 30 31 03 49 21 47 58 30 36 0D 0A',
            // I!GX05
            'tare' => '30 03 32 35 34 03 30 30 31 03 49 21 47 58 30 35 0D 0A',
            // I!LV01|GW01|1|LX02
            'change_to_1' => '30 03 32 35 34 03 30 30 31 03 49 21 4C 56 30 31 7C 47 57 30 31 7C 31 7C 4C 58 30 32 0D 0A',
            // I!LV01|GW01|2|LX02
            'change_to_2' => '30 03 32 35 34 03 30 30 31 03 49 21 4C 56 30 31 7C 47 57 30 31 7C 32 7C 4C 58 30 32 0D 0A',
            // I?LV01|RX02|STA7|GD01;GD02;GD07|LX02
            'get_weights' => '30 03 32 35 34 03 30 30 31 03 49 3F 4C 56 30 31 7C 52 58 30 32 7C 53 54 41 37 7C 47 44 30 31 3B 47 44 30 32 3B 47 44 30 37 7C 4C 58 30 32 0D 0A',
        ],
    ];

    /** Campo de la trama Bizerba -> clave de peso. Solo para el camino heredado. */
    public const SCALE_MAPPINGS = [
        'bizerba' => [
            'GD01' => 'net',   // Neto
            'GD02' => 'tare',  // Tara
            'GD07' => 'gross', // Bruto
        ],
    ];
```

- [ ] **Step 4: Reescribir los seis métodos para usar el gateway**

Añadir el `use` y sustituir los métodos. `sendScaleCommand()` y `sendCommandOrFail()` desaparecen: su trabajo lo hace el gateway.

```php
use App\Modules\SGA\Services\ScaleGateway;
use App\Modules\SGA\Services\ScaleResponse;
```

```php
    public function testConnection(Scale $scale): JsonResponse
    {
        if (!$scale->ip_address || !$scale->port) {
            return response()->json([
                'connected' => false,
                'message' => __('SGA::messages.scale.scale_missing_values'),
            ]);
        }

        $result = (new ScaleGateway())->call($scale, 'info');

        if (!$result->success) {
            return response()->json([
                'connected' => false,
                'message' => $result->message ?? __('SGA::messages.scale.connection_failed'),
            ]);
        }

        return response()->json([
            'connected' => true,
            'message' => __('SGA::messages.scale.info_success'),
            'scale_info' => $result->data,
        ]);
    }

    public function info(): JsonResponse
    {
        return $this->runOperation('info', 'info_success', fn (ScaleResponse $r) => [
            'scale_response' => $r->data,
        ]);
    }

    public function deleteTare(): JsonResponse
    {
        return $this->runOperation('clearTare', 'delete_tare_success');
    }

    public function tare(): JsonResponse
    {
        return $this->runOperation('tare', 'tare_success');
    }

    public function changeToScale(int $number): JsonResponse
    {
        if (!in_array($number, [1, 2], true)) {
            return $this->jsonError(
                __('SGA::messages.scale.invalid_scale_number'),
                Response::HTTP_BAD_REQUEST,
            );
        }

        return $this->runOperation(
            'selectPlatform',
            'change_scale_success',
            null,
            ['platform' => $number],
            ['number' => $number],
        );
    }

    public function getWeights(): JsonResponse
    {
        return $this->runOperation('weigh', 'get_weights_success', fn (ScaleResponse $r) => [
            // En scale-v1 los pesos ya vienen en gramos del driver; en legacy los ha
            // normalizado ScaleWeightParser. En los dos casos, no reconvertir.
            'weights' => array_intersect_key($r->data, array_flip(['net', 'tare', 'gross'])),
        ]);
    }

    /**
     * Resuelve la bascula del puesto, ejecuta la operacion y traduce el resultado.
     *
     * @param callable(ScaleResponse): array<string, mixed>|null $payload
     * @param array<string, mixed> $params
     * @param array<string, mixed> $messageArgs
     */
    private function runOperation(
        string $operation,
        string $messageKey,
        ?callable $payload = null,
        array $params = [],
        array $messageArgs = [],
    ): JsonResponse {
        $scale = $this->getValidatedScale();
        if ($scale instanceof JsonResponse) {
            return $scale;
        }

        $result = (new ScaleGateway())->call($scale, $operation, $params);

        if (!$result->success) {
            // El estado se conserva: un 501 significa "esta bascula no sabe hacerlo",
            // que no es lo mismo que un fallo y el cliente debe poder distinguirlo.
            return $this->jsonError(
                $result->message ?? __('SGA::messages.scale.scale_command_failed'),
                $result->status,
            );
        }

        return response()->json(array_merge([
            'message' => __("SGA::messages.scale.{$messageKey}", $messageArgs),
        ], $payload ? $payload($result) : []));
    }
```

Borrar los métodos `sendCommandOrFail()` y `sendScaleCommand()`, que ya no se usan.
`findScale()`, `getLocalIpFromElectron()`, `getValidatedScale()` y `jsonError()` se quedan.

- [ ] **Step 5: Comprobar que no queda ninguna referencia a lo borrado**

```bash
grep -rn "sendScaleCommand\|sendCommandOrFail\|SCALE_COMMANDS\['mettler\|SCALE_MAPPINGS\['mettler\|Assuming we're working with Bizerba" app/ resources/ tests/
```
Expected: sin resultados. Si aparece algo en `app/Modules/SGA/resources/views/`, arreglarlo ahí.

- [ ] **Step 6: Ejecutar los tests**

Run: `php artisan test --filter=ScaleControllerBrandTest`
Expected: PASS, 5 tests y 1 saltado.

Run: `php artisan test --filter=ScaleWeightParserTest`
Expected: PASS, 4 tests. `ScaleWeightParser` no se ha tocado y debe seguir verde.

- [ ] **Step 7: Estilo y commit**

```bash
./vendor/bin/pint app/Modules/SGA/Http/Controllers/Admin/ScaleController.php
git add app/Modules/SGA/Http/Controllers/Admin/ScaleController.php tests/Feature/Modules/SGA/ScaleControllerBrandTest.php
git commit -m "refactor(sga): route scale operations through ScaleGateway

Drops the mettler_toledo command and mapping placeholders: 'SCALE,1' is
not MT-SICS and an ICS4xx would not understand it, so leaving them was a
trap for whoever read them next. Also drops the unused non-hex bizerba
map.

The 'Assuming we're working with Bizerba scales' TODO is gone because it
stopped being true. Error status codes are preserved end to end."
```

---

### Task 5: El navegador deja de mandar tramas

Último paso. `validateScaleSetup()` decide el camino en servidor y el navegador branchea una sola vez, de forma que el camino viejo queda aislado y borrable en un commit.

**Files:**
- Modify: `app/Modules/SGA/Http/Controllers/Admin/InboundDeliveryLineController.php:491-499`
- Modify: `app/Modules/SGA/resources/views/riho/inbound-delivery/tub/js/utils.blade.php:74-124`
- Create: `tests/Feature/Modules/SGA/ValidateScaleSetupTest.php`

**Interfaces:**
- Consumes: `ScaleGateway` de Task 3.
- Produces: el payload `scale` de `validateScaleSetup()` gana `brand`, `model`, `options` y `api`.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/ValidateScaleSetupTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ValidateScaleSetupTest extends TestCase
{
    use RefreshDatabase;

    private const DESKTOP = 'http://localhost:3000';

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('sga.desktop_app_service', self::DESKTOP);
    }

    private function scaleOn(string $ip, array $attributes = []): Scale
    {
        $workstation = WorkStation::factory()->create(['ip_address' => $ip]);

        return Scale::factory()->create(array_merge([
            'workstation_id' => $workstation->id,
            'is_active' => true,
            'ip_address' => '192.168.0.86',
            'port' => 4305,
            'brand' => 'mettler_toledo',
        ], $attributes));
    }

    private function fakeModernDesktop(): void
    {
        Http::fake([
            self::DESKTOP . '/health' => Http::response([
                'version' => '1.3.0', 'apis' => ['legacy', 'scale-v1'],
                'brands' => ['mettler_toledo', 'bizerba'],
            ]),
        ]);
    }

    public function test_a_modern_desktop_gets_the_scale_v1_payload_without_telegrams(): void
    {
        $this->scaleOn('10.0.0.5', ['model' => 'ics425']);
        $this->fakeModernDesktop();

        $response = $this->actingAsSgaAdmin()->postJson(
            route('admin.inbound_delivery_lines.validate_scale_setup'),
            ['ipAddress' => '10.0.0.5'],
        );

        $response->assertOk()
            ->assertJsonPath('scale.api', 'scale-v1')
            ->assertJsonPath('scale.brand', 'mettler_toledo')
            ->assertJsonPath('scale.model', 'ics425')
            ->assertJsonPath('scale.port', 4305);

        // El navegador ya no necesita saber una sola trama.
        $response->assertJsonMissingPath('scale.commands')
            ->assertJsonMissingPath('scale.mappings');
    }

    public function test_an_old_desktop_gets_the_legacy_payload_with_telegrams(): void
    {
        $this->scaleOn('10.0.0.6', ['brand' => 'bizerba', 'port' => 10051, 'model' => null]);
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = $this->actingAsSgaAdmin()->postJson(
            route('admin.inbound_delivery_lines.validate_scale_setup'),
            ['ipAddress' => '10.0.0.6'],
        );

        $response->assertOk()
            ->assertJsonPath('scale.api', 'legacy')
            ->assertJsonPath('scale.brand', 'bizerba')
            ->assertJsonStructure(['scale' => ['commands', 'mappings']]);
    }

    public function test_a_mettler_with_an_old_desktop_is_reported_as_a_setup_problem(): void
    {
        $this->scaleOn('10.0.0.7', ['brand' => 'mettler_toledo']);
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $response = $this->actingAsSgaAdmin()->postJson(
            route('admin.inbound_delivery_lines.validate_scale_setup'),
            ['ipAddress' => '10.0.0.7'],
        );

        // Sin camino que funcione, el puesto cae a captura manual con motivo.
        $response->assertOk()
            ->assertJsonPath('calculate_units_manually', true)
            ->assertJsonPath('scale_error', 'desktop_outdated');
    }

    public function test_a_bizerba_with_options_and_an_old_desktop_is_also_a_setup_problem(): void
    {
        $this->scaleOn('10.0.0.8', [
            'brand' => 'bizerba', 'port' => 10051,
            'protocol_options' => ['addressPrefix' => ['1', '200', '002']],
        ]);
        Http::fake([self::DESKTOP . '/health' => Http::response(null, 404)]);

        $this->actingAsSgaAdmin()->postJson(
            route('admin.inbound_delivery_lines.validate_scale_setup'),
            ['ipAddress' => '10.0.0.8'],
        )->assertOk()->assertJsonPath('scale_error', 'desktop_outdated');
    }

    public function test_an_inactive_scale_still_falls_back_to_manual(): void
    {
        $this->scaleOn('10.0.0.9', ['is_active' => false]);
        $this->fakeModernDesktop();

        $this->actingAsSgaAdmin()->postJson(
            route('admin.inbound_delivery_lines.validate_scale_setup'),
            ['ipAddress' => '10.0.0.9'],
        )->assertOk()->assertJsonPath('calculate_units_manually', true);
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `php artisan test --filter=ValidateScaleSetupTest`
Expected: FAIL — el payload no tiene `scale.api`.

- [ ] **Step 3: Reescribir el final de `validateScaleSetup()`**

En `app/Modules/SGA/Http/Controllers/Admin/InboundDeliveryLineController.php`, sustituir el
`return` final (el que hoy devuelve `commands` y `mappings` cableados a Bizerba) por:

```php
        $gateway = new ScaleGateway();
        $api = $gateway->apiFor($scale);

        // El camino legacy manda tramas ya montadas: no sabe aplicar model ni
        // protocol_options, y una Mettler no tiene equivalente heredado. En esos
        // casos se cae a captura manual diciendo por que, en vez de intentarlo y
        // dejar al operario con una bascula muda.
        if ($api === ScaleGateway::API_LEGACY
            && ($scale->brand !== 'bizerba' || $scale->model !== null || !empty($scale->protocol_options))
        ) {
            return response()->json([
                'calculate_units_manually' => true,
                'scale_error' => 'desktop_outdated',
                'message' => __('SGA::messages.scale.desktop_outdated_options'),
            ], Response::HTTP_OK);
        }

        $payload = [
            'ip' => $scale->ip_address,
            'port' => $scale->port,
            'brand' => $scale->brand,
            'model' => $scale->model,
            'options' => $scale->protocol_options,
            'api' => $api,
        ];

        if ($api === ScaleGateway::API_LEGACY) {
            // Solo el camino viejo necesita las tramas en el navegador.
            $payload['commands'] = ScaleController::SCALE_COMMANDS['bizerba_hex'];
            $payload['mappings'] = ScaleController::SCALE_MAPPINGS['bizerba'];
        }

        return response()->json([
            'message' => 'success',
            'scale' => $payload,
        ]);
```

Añadir el `use App\Modules\SGA\Services\ScaleGateway;` arriba.

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `php artisan test --filter=ValidateScaleSetupTest`
Expected: PASS, 5 tests.

- [ ] **Step 5: Branchear `callElectron` en el navegador**

En `app/Modules/SGA/resources/views/riho/inbound-delivery/tub/js/utils.blade.php`, sustituir las
funciones `callElectron` y `getScaleWeights` por:

```js
    // Mapa operacion -> ruta de scale-v1, en kebab-case como las monta VerentiaIP.
    const SCALE_V1_ROUTES = {
        get_weights: 'weigh',
        tare: 'tare',
        delete_tare: 'clear-tare',
        info: 'info',
        change_to_1: 'select-platform',
        change_to_2: 'select-platform',
    };

    function callElectron(commandKey) {
        if (!window.scaleConfig) {
            return Promise.reject('scaleConfig_not_ready');
        }
        const cfg = window.scaleConfig;

        // --- camino nuevo: VerentiaIP conoce el protocolo -------------------------
        if (cfg.api === 'scale-v1') {
            const route = SCALE_V1_ROUTES[commandKey];
            if (!route) {
                return Promise.reject('unknown_command');
            }
            const body = {
                ip: cfg.ip,
                port: cfg.port,
                brand: cfg.brand,
            };
            if (cfg.model) { body.model = cfg.model; }
            if (cfg.options) { body.options = cfg.options; }
            if (commandKey === 'change_to_1') { body.platform = 1; }
            if (commandKey === 'change_to_2') { body.platform = 2; }

            return fetch(window.electronServiceUrl + '/scale/' + route, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }).then(r => r.json());
        }

        // --- camino heredado: el navegador manda la trama ya montada --------------
        // Borrable en un solo commit cuando ya no queden escritorios sin actualizar.
        const hex = cfg.commands ? cfg.commands[commandKey] : null;
        if (!hex) {
            return Promise.reject('unknown_command');
        }
        return fetch(window.electronServiceUrl + '/scale-hex', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: cfg.ip, port: cfg.port, hex: hex }),
        }).then(r => r.json());
    }

    function getScaleWeights() {
        return callElectron('get_weights').then(function(result) {
            if (!result || result.success !== true) {
                return Promise.reject('invalid_response');
            }

            // En scale-v1 los pesos ya vienen en gramos del driver.
            if (window.scaleConfig.api === 'scale-v1') {
                return {
                    net: result.data.net,
                    tare: result.data.tare,
                    gross: result.data.gross,
                };
            }

            // --- camino heredado -------------------------------------------------
            if (typeof result.response_ascii !== 'string') {
                return Promise.reject('invalid_response');
            }
            const parts    = result.response_ascii.split('|');
            const mappings = window.scaleConfig.mappings;
            const weights  = { net: null, tare: null, gross: null };

            // Cada campo responde con `unidad;exponente;valor` (p.ej. kg;-3;0). La
            // magnitud real es valor * 10^exponente, normalizada aqui a gramos.
            parts.forEach(function(part, index) {
                if (mappings[part] && parts[index + 1]) {
                    const data = parts[index + 1].split(';');
                    if (data.length < 3) { return; }
                    const unit     = data[0];
                    const exponent = parseInt(data[1], 10);
                    const rawValue = parseFloat(data[2]);
                    let   value    = rawValue * Math.pow(10, exponent);
                    if (unit === 'kg') { value = value * 1000; }
                    weights[mappings[part]] = { unit: 'g', value: value };
                }
            });

            return weights;
        });
    }
```

- [ ] **Step 6: Verificación manual del flujo completo**

Con VerentiaIP del plan A corriendo y la ICS425 en `192.168.0.86:4305`:

1. Dar de alta una báscula Mettler Toledo apuntando a esa IP y puerto, asignada al puesto cuya
   IP devuelve `GET /ip` del escritorio.
2. Pulsar "Probar conexión" en el detalle de la báscula. Debe salir conectada y traer el modelo.
3. Abrir el flujo de cubetas de entrada de mercancía y pedir una pesada. En la consola del
   navegador debe verse la petición a `/scale/weigh`, **no** a `/scale-hex`.
4. Comprobar que el peso mostrado coincide con el del display de la báscula.

- [ ] **Step 7: Ejecutar la suite completa del módulo**

Run: `php artisan test --filter="Scale|ValidateScaleSetup"`
Expected: PASS. Total acumulado del plan: 39 tests y 1 saltado.

- [ ] **Step 8: Estilo y commit**

```bash
./vendor/bin/pint app/Modules/SGA/Http/Controllers/Admin/InboundDeliveryLineController.php
git add app/Modules/SGA tests/Feature/Modules/SGA/ValidateScaleSetupTest.php
git commit -m "feat(sga): stop sending scale telegrams from the browser

validateScaleSetup decides the path server-side and the browser branches
once on cfg.api. The legacy branch keeps the JS triplet parser and the hex
map, isolated so it can be deleted in a single commit once no desktop app
is left unupdated.

A Mettler or a model/options override on an old desktop falls back to
manual capture with a stated reason instead of trying and failing mutely."
```

---

## Verificación final del plan

- [ ] `php artisan test --filter="Scale|ValidateScaleSetup"` pasa entero.
- [ ] `./vendor/bin/pint --test app/Modules/SGA` no reporta cambios pendientes.
- [ ] `grep -rn "SCALE_COMMANDS\['mettler\|SCALE_MAPPINGS\['mettler\|sendScaleCommand" app/ resources/ tests/` no devuelve nada.
- [ ] `grep -rn "SCALE_MODEL_OPTIONS" app/ resources/` solo aparece con el significado nuevo
  (modelos agrupados por marca), nunca como lista de marcas.
- [ ] Las básculas que existían antes de la migración están todas en `brand = 'bizerba'`.
- [ ] En el formulario, cambiar la marca cambia los modelos ofrecidos.
- [ ] Con VerentiaIP actualizado, una pesada real desde el flujo de cubetas va por `/scale/weigh`
  y el peso coincide con el display de la báscula.
- [ ] Con VerentiaIP antiguo (o `/health` devolviendo 404 a mano), una Bizerba sin modelo ni
  opciones sigue funcionando por `/scale-hex` exactamente como antes.

**Pendiente que no se puede cerrar aquí:** no hay Bizerba física en el banco de pruebas, así que
la rama legacy y el driver Bizerba están cubiertos por tramas grabadas y `Http::fake()`, no por
hierro. Antes de producción hay que probar una pesada real contra una Bizerba, por los dos
caminos.
