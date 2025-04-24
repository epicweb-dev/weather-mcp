/// <reference path="../types/worker-configuration.d.ts" />

import { AsyncLocalStorage } from 'async_hooks'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'

export interface Env {
	ACCUWEATHER_API_KEY: string
}

const requestStorage = new AsyncLocalStorage<Request>()

const accuWeatherLocationSchema = z.object({
	Key: z.string(),
	LocalizedName: z.string(),
	Country: z.object({
		LocalizedName: z.string(),
	}),
})

const accuWeatherCurrentConditionsSchema = z.object({
	WeatherText: z.string(),
	Temperature: z.object({
		Metric: z.object({
			Value: z.number(),
			Unit: z.string(),
		}),
		Imperial: z.object({
			Value: z.number(),
			Unit: z.string(),
		}),
	}),
	RelativeHumidity: z.number().optional(),
	Wind: z
		.object({
			Speed: z.object({
				Metric: z.object({
					Value: z.number(),
					Unit: z.string(),
				}),
				Imperial: z.object({
					Value: z.number(),
					Unit: z.string(),
				}),
			}),
		})
		.optional(),
})

// Helper function to get location key from coordinates
async function getLocationKey(
	latitude: number,
	longitude: number,
	apiKey: string,
) {
	const url = new URL(
		'http://dataservice.accuweather.com/locations/v1/cities/geoposition/search',
	)
	url.searchParams.append('apikey', apiKey)
	url.searchParams.append('q', `${latitude},${longitude}`)
	url.searchParams.append('details', 'true')

	const response = await fetch(url.toString())
	const json = await response.json()
	const data = accuWeatherLocationSchema.parse(json)
	return {
		locationKey: data.Key,
		city: data.LocalizedName,
		country: data.Country.LocalizedName,
	}
}

// Helper function to get current weather conditions
async function getCurrentConditions(locationKey: string, apiKey: string) {
	const url = new URL(
		`http://dataservice.accuweather.com/currentconditions/v1/${locationKey}`,
	)
	url.searchParams.append('apikey', apiKey)
	url.searchParams.append('details', 'true')

	const response = await fetch(url.toString())
	const data = (await response.json()) as unknown[]
	return accuWeatherCurrentConditionsSchema.parse(data[0])
}

export class WeatherMCP extends McpAgent<Env> {
	server = new McpServer(
		{
			name: 'Weather',
			version: '1.0.0',
		},
		{
			instructions: `
Weather is a tool that allows users to get the weather of a given latitude and longitude.
			`.trim(),
		},
	)

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
	}

	onSSEMcpMessage(sessionId: string, request: Request) {
		return requestStorage.run(request, async () =>
			super.onSSEMcpMessage(sessionId, request),
		)
	}

	async init() {
		this.server.tool(
			'getWeather',
			'Get the weather of a given latitude and longitude.',
			{
				latitude: z.coerce
					.number()
					.optional()
					.describe(
						'The latitude of the location to get the weather for. Defaults to the latitude of the request.',
					),
				longitude: z.coerce
					.number()
					.optional()
					.describe(
						'The longitude of the location to get the weather for. Defaults to the longitude of the request.',
					),
				unit: z
					.enum(['celsius', 'fahrenheit'])
					.optional()
					.default('fahrenheit')
					.describe(
						'The unit of the temperature to get the weather for. Defaults to fahrenheit.',
					),
			},
			async ({ latitude, longitude, unit }) => {
				try {
					const lat = latitude ?? requestStorage.getStore()?.cf?.latitude
					const long = longitude ?? requestStorage.getStore()?.cf?.longitude

					invariant(
						typeof lat === 'number',
						'Latitude is required and could not be found',
					)
					invariant(
						typeof long === 'number',
						'Longitude is required and could not be found',
					)

					const apiKey = this.env.ACCUWEATHER_API_KEY
					invariant(apiKey, 'ACCUWEATHER_API_KEY is required')

					// Get location details and key
					const { locationKey, city, country } = await getLocationKey(
						lat,
						long,
						apiKey,
					)

					// Get current weather conditions
					const weatherData = await getCurrentConditions(locationKey, apiKey)

					// Get temperature in the requested unit
					const temperature =
						unit === 'fahrenheit'
							? weatherData.Temperature.Imperial.Value
							: weatherData.Temperature.Metric.Value

					return {
						content: [
							{
								type: 'text',
								text: `
Weather in ${city}, ${country}:
• Temperature: ${temperature.toFixed(1)}°${unit === 'fahrenheit' ? 'F' : 'C'}
${weatherData.RelativeHumidity ? `• Humidity: ${weatherData.RelativeHumidity}%` : ''}
${weatherData.Wind ? `• Wind Speed: ${weatherData.Wind.Speed.Metric.Value} ${weatherData.Wind.Speed.Metric.Unit}` : ''}
• Conditions: ${weatherData.WeatherText}
								`.trim(),
							},
						],
					}
				} catch (error) {
					return {
						isError: true,
						content: [{ type: 'text', text: getErrorMessage(error) }],
					}
				}
			},
		)
	}
}

function getErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	console.error('Unable to get error message for error', error)
	return 'Unknown Error'
}

export default WeatherMCP.mount('/mcp', {
	binding: 'WEATHER_MCP_OBJECT',
})
