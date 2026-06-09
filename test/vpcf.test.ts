import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVpcf } from "../src/dota/vpcf.js";

// A representative decompiled .vpcf (shape matches ValveResourceFormat KV3 output).
const SAMPLE = `<!-- kv3 -->
{
	m_nMaxParticles = 8
	m_ConstantColor = [ 255, 255, 255, 155 ]
	m_Renderers =
	[
		{
			_class = "C_OP_RenderSprites"
			m_hTexture = resource:"materials/particle/smoke/steam/steam.vtex"
			m_nOutputBlendMode = "PARTICLE_OUTPUT_BLEND_MODE_ADD"
		},
	]
	m_Operators =
	[
		{
			_class = "C_OP_BasicMovement"
			m_Gravity = [ 0.0, 0.0, 250.0 ]
		},
		{
			_class = "C_OP_InterpolateRadius"
			m_flStartScale = 0.0
			m_flEndScale = 2.0
		},
		{
			_class = "C_OP_ColorInterpolate"
			m_ColorFade = [ 168, 70, 0, 255 ]
		},
	]
	m_Initializers =
	[
		{
			_class = "C_INIT_InitFloat"
			m_InputValue = { m_flRandomMin = 0.7 m_flRandomMax = 1.3 }
			m_nOutputField = 1
		},
		{
			_class = "C_INIT_InitFloat"
			m_InputValue = { m_flRandomMin = 44.0 m_flRandomMax = 72.0 }
		},
		{
			_class = "C_INIT_RandomColor"
			m_ColorMax = [ 141, 255, 103, 255 ]
			m_ColorMin = [ 47, 255, 65, 255 ]
		},
	]
	m_Emitters =
	[
		{
			_class = "C_OP_ContinuousEmitter"
			m_flEmissionDuration = { m_nType = "PF_TYPE_LITERAL" m_flLiteralValue = 0.5 }
			m_flEmitRate = { m_nType = "PF_TYPE_LITERAL" m_flLiteralValue = 20.0 }
		},
	]
}`;

test("parseVpcf extracts sprite, blend, emission, lifespan, radius, colours, gravity", () => {
  const s = parseVpcf(SAMPLE);
  assert.equal(s.sprite, "materials/particle/smoke/steam/steam.vtex");
  assert.equal(s.additive, true);
  assert.equal(s.maxParticles, 8);
  assert.equal(s.emitRate, 20);
  assert.equal(s.emitDuration, 0.5);
  // lifespan from InitFloat field 1 = avg(0.7,1.3) = 1.0
  assert.ok(Math.abs(s.lifespan - 1.0) < 1e-6, `lifespan ${s.lifespan}`);
  // radius from the field-3 (default) InitFloat = avg(44,72) = 58
  assert.equal(s.radius, 58);
  assert.equal(s.startScale, 0); // raw start scale honoured
  assert.equal(s.endScale, 2);
  // start colour = avg of RandomColor min/max
  assert.deepEqual(s.colorStart.map(Math.round), [94, 255, 84]);
  assert.deepEqual(s.colorEnd, [168, 70, 0]); // ColorFade
  assert.equal(s.gravityZ, 250);
  assert.ok(s.baseAlpha > 0.5 && s.baseAlpha < 0.7); // 155/255
});

test("parseVpcf falls back sanely on a near-empty particle", () => {
  const s = parseVpcf(`{ m_Renderers = [ { _class = "C_OP_RenderSprites" m_hTexture = resource:"a/b/c.vtex" } ] }`);
  assert.equal(s.sprite, "a/b/c.vtex");
  assert.ok(s.lifespan > 0 && s.radius > 0);
  assert.ok(s.burst > 0 || s.emitRate > 0, "something must emit");
  assert.ok(s.colorStart.length === 3 && s.colorEnd.length === 3);
});

test("parseVpcf reads an instantaneous burst emitter", () => {
  const s = parseVpcf(`{
    m_Renderers = [ { _class="C_OP_RenderSprites" m_hTexture=resource:"x.vtex" } ]
    m_Emitters = [ { _class="C_OP_InstantaneousEmitter" m_nParticlesToEmit = { m_flLiteralValue = 50 } } ]
  }`);
  assert.equal(s.burst, 50);
});
