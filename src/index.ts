/// <reference path="../types/worker-configuration.d.ts" />

import { AsyncLocalStorage } from 'async_hooks'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'

const requestStorage = new AsyncLocalStorage<Request>()

interface GeocodingResult {
	name: string
	latitude: number
	longitude: number
	country: string
	results: Array<{
		name: string
		latitude: number
		longitude: number
		country: string
	}>
}

interface WeatherResult {
	current: {
		temperature_2m: number
		relative_humidity_2m: number
		wind_speed_10m: number
		weather_code: number
	}
}

export class CoutryWeatherMCP extends McpAgent<Env> {
	server = new McpServer(
		{
			name: 'CountryWeather',
			version: '1.0.0',
		},
		{
			instructions: `
CountryWeather is a tool that allows users to get the weather of a given country.
			`.trim(),
		},
	)
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
	}

	onSSEMcpMessage(sessionId: string, request: Request) {
		return requestStorage.run(request, () =>
			super.onSSEMcpMessage(sessionId, request),
		)
	}

	async init() {
		this.server.tool(
			'getWeather',
			'Get the weather of a given country. Defaults to the country found via the `CF-IPCountry` header.',
			{
				country: z.string().optional(),
			},
			async ({ country }) => {
				const request = requestStorage.getStore()
				country ??= request?.headers.get('CF-IPCountry') ?? undefined
				if (!country) {
					return {
						isError: true,
						content: [{ type: 'text', text: 'Country not detected' }],
					}
				}

				// First get coordinates for the country using geocoding API
				const geocodingResponse = await fetch(
					`https://geocoding-api.open-meteo.com/v1/search?name=${country}&count=1`,
				)
				const geocodingData =
					(await geocodingResponse.json()) as GeocodingResult

				if (!geocodingData.results?.[0]) {
					return {
						isError: true,
						content: [{ type: 'text', text: 'Country not found' }],
					}
				}

				const { latitude, longitude } = geocodingData.results[0]

				// Then get weather data using those coordinates
				const weatherResponse = await fetch(
					`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
				)
				const weatherData = (await weatherResponse.json()) as WeatherResult

				if (!weatherData.current) {
					return {
						isError: true,
						content: [{ type: 'text', text: 'Weather data not available' }],
					}
				}

				// Convert weather code to description
				const weatherDescription = getWeatherDescription(
					weatherData.current.weather_code,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Weather in ${geocodingData.results[0].name}, ${geocodingData.results[0].country}:
• Temperature: ${weatherData.current.temperature_2m}°C
• Humidity: ${weatherData.current.relative_humidity_2m}%
• Wind Speed: ${weatherData.current.wind_speed_10m} km/h
• Conditions: ${weatherDescription}`,
						},
					],
				}
			},
		)
	}
}

// Helper function to convert WMO weather codes to descriptions
function getWeatherDescription(code: number): string {
	const weatherCodes: Record<number, string> = {
		0: 'Clear sky',
		1: 'Mainly clear',
		2: 'Partly cloudy',
		3: 'Overcast',
		45: 'Foggy',
		48: 'Depositing rime fog',
		51: 'Light drizzle',
		53: 'Moderate drizzle',
		55: 'Dense drizzle',
		56: 'Light freezing drizzle',
		57: 'Dense freezing drizzle',
		61: 'Slight rain',
		63: 'Moderate rain',
		65: 'Heavy rain',
		66: 'Light freezing rain',
		67: 'Heavy freezing rain',
		71: 'Slight snow fall',
		73: 'Moderate snow fall',
		75: 'Heavy snow fall',
		77: 'Snow grains',
		80: 'Slight rain showers',
		81: 'Moderate rain showers',
		82: 'Violent rain showers',
		85: 'Slight snow showers',
		86: 'Heavy snow showers',
		95: 'Thunderstorm',
		96: 'Thunderstorm with slight hail',
		99: 'Thunderstorm with heavy hail',
	}
	return weatherCodes[code] || 'Unknown'
}

export default CoutryWeatherMCP.mount('/mcp', {
	binding: 'COUNTRY_WEATHER_MCP_OBJECT',
})
